# Idempotent repo secrets from fleet-control/config.json + fleet-control/.tailscale-api-key
# Never prints secret values. Usage: .\scripts\fleet-secrets.ps1 [-SkipAgentToken]
param(
  [switch]$SkipAgentToken,
  [string]$Gh = "D:\Tools\gh\bin\gh.exe"
)

$ErrorActionPreference = "Stop"
if (-not (Test-Path -LiteralPath $Gh)) { $Gh = "gh" }

$RepoRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$FleetDir = Join-Path $RepoRoot "fleet-control"
$ConfigPath = Join-Path $FleetDir "config.json"
$KeyFile = Join-Path $FleetDir ".tailscale-api-key"

function Get-TsApiKey {
  if (Test-Path -LiteralPath $KeyFile) {
    $line = (Get-Content -LiteralPath $KeyFile -ErrorAction SilentlyContinue |
      Where-Object { $_ -and $_ -notmatch '^\s*#' }) | Select-Object -First 1
    if ($line) {
      $t = $line.Trim().Trim('"').Trim("'")
      if ($t.Length -gt 10) { return $t }
    }
  }
  foreach ($envName in @("TAILSCALE_API_KEY", "TS_API_KEY_MAIN")) {
    $v = [Environment]::GetEnvironmentVariable($envName)
    if ($v -and $v.Length -gt 10) { return $v.Trim() }
  }
  return $null
}

function Set-GhRepoSecretFromValue {
  param([string]$Name, [string]$Value, [string]$TargetRepo)
  $utf8NoBom = New-Object System.Text.UTF8Encoding $false
  $tmp = Join-Path $env:TEMP ("fleet-secret-" + [guid]::NewGuid().ToString("n") + ".txt")
  try {
    [System.IO.File]::WriteAllText($tmp, $Value, $utf8NoBom)
    Get-Content -LiteralPath $tmp -Raw | & $Gh secret set $Name --repo $TargetRepo
    if ($LASTEXITCODE -ne 0) { throw "gh secret set $Name failed for $TargetRepo" }
  } finally {
    Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
  }
}

function Test-GhRepoSecret {
  param([string]$TargetRepo, [string]$SecretName)
  $names = & $Gh secret list --repo $TargetRepo --json name 2>$null | ConvertFrom-Json
  if (-not $names) { return $false }
  return [bool](@($names) | Where-Object { $_.name -eq $SecretName })
}

function New-TailscaleAuthKey {
  param([string]$ApiKey)
  $pair = "${ApiKey}:"
  $b64 = [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes($pair))
  $headers = @{
    Authorization  = "Basic $b64"
    "Content-Type" = "application/json"
  }
  $body = @{
    capabilities  = @{
      devices = @{
        create = @{
          reusable      = $true
          ephemeral     = $false
          preauthorized = $true
        }
      }
    }
    description   = "fleet-rdp-lxde"
    expirySeconds = 7776000
  } | ConvertTo-Json -Depth 6 -Compress

  $keyResp = Invoke-RestMethod -Uri "https://api.tailscale.com/api/v2/tailnet/-/keys" `
    -Headers $headers -Method Post -Body $body
  if (-not $keyResp.key) { throw "Tailscale API did not return auth key" }
  return [string]$keyResp.key
}

if (-not (Test-Path -LiteralPath $ConfigPath)) {
  Write-Error "Missing $ConfigPath - copy config.example.json to config.json first."
  exit 2
}

$raw = Get-Content -LiteralPath $ConfigPath -Raw
if ($raw.Length -gt 0 -and [int][char]$raw[0] -eq 0xFEFF) { $raw = $raw.Substring(1) }
$cfg = $raw | ConvertFrom-Json
$accounts = @()
if ($cfg.github_accounts) { $accounts += @($cfg.github_accounts) }
elseif ($cfg.accounts) { $accounts += @($cfg.accounts) }

$enabled = @($accounts | Where-Object { $_.enabled -ne $false })
if (-not $enabled.Count) {
  Write-Error "No enabled accounts in config.json"
  exit 2
}

$agentToken = $env:FLEET_AGENT_TOKEN
if (-not $agentToken -and $cfg.fleet_agent_token -and $cfg.fleet_agent_token -notmatch '^change-me') {
  $agentToken = [string]$cfg.fleet_agent_token
}

foreach ($acct in $enabled) {
  $ghUser = $acct.gh_user
  if ($ghUser) {
    $prevEap = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    & $Gh auth switch -u $ghUser 2>&1 | Out-Null
    $switchCode = $LASTEXITCODE
    $ErrorActionPreference = $prevEap
    if ($switchCode -ne 0) {
      Write-Warning "gh auth switch -u $ghUser failed - continuing with current gh user"
    }
  }

  foreach ($repo in @($acct.repos)) {
    if (-not $repo -or $repo -match 'YOUR_|OTHER_ORG|example\.com') { continue }
    Write-Host "Secrets: $repo ($($acct.name))"

    if (Test-GhRepoSecret -TargetRepo $repo -SecretName "TAILSCALE_AUTH_KEY") {
      Write-Host "  TAILSCALE_AUTH_KEY: already set - skip"
    } else {
      $apiKey = Get-TsApiKey
      if (-not $apiKey) {
        Write-Error "Need Tailscale API key in $KeyFile (or env) to create TAILSCALE_AUTH_KEY"
        exit 2
      }
      Write-Host "  TAILSCALE_AUTH_KEY: creating via Tailscale API..."
      $authKey = New-TailscaleAuthKey -ApiKey $apiKey
      Set-GhRepoSecretFromValue -Name "TAILSCALE_AUTH_KEY" -Value $authKey -TargetRepo $repo
      Write-Host "  TAILSCALE_AUTH_KEY: set"
    }

    if (-not $SkipAgentToken) {
      if (Test-GhRepoSecret -TargetRepo $repo -SecretName "FLEET_AGENT_TOKEN") {
        Write-Host "  FLEET_AGENT_TOKEN: already set - skip"
      } elseif ($agentToken) {
        Set-GhRepoSecretFromValue -Name "FLEET_AGENT_TOKEN" -Value $agentToken -TargetRepo $repo
        Write-Host "  FLEET_AGENT_TOKEN: set"
      } else {
        Write-Warning "  FLEET_AGENT_TOKEN: not set locally - use env FLEET_AGENT_TOKEN or setup-account"
      }
    }

    if (Test-GhRepoSecret -TargetRepo $repo -SecretName "TERMINAL_SSH_PASSWORD") {
      Write-Host "  TERMINAL_SSH_PASSWORD: already set - skip"
    } else {
      $sshPw = [Environment]::GetEnvironmentVariable("TERMINAL_SSH_PASSWORD")
      if (-not $sshPw) { $sshPw = "agkalitsa" }
      Set-GhRepoSecretFromValue -Name "TERMINAL_SSH_PASSWORD" -Value $sshPw -TargetRepo $repo
      Write-Host "  TERMINAL_SSH_PASSWORD: set"
    }
  }
}

Write-Host "Secrets pass complete."
