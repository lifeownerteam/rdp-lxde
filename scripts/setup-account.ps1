# One-time local setup for a GitHub user + rdp-lxde repo (no passwords in chat).
# Usage: .\scripts\setup-account.ps1 [-Username ryansims046]
param(
  [string]$Username = "ryansims046",
  [string]$Gh = "D:\Tools\gh\bin\gh.exe"
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path -LiteralPath $Gh)) { $Gh = "gh" }

$RepoRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$FleetDir = Join-Path $RepoRoot "fleet-control"
$ExampleConfig = Join-Path $FleetDir "config.example.json"
$FleetConfig = Join-Path $FleetDir "config.json"
$RepoFull = "$Username/rdp-lxde"
$RemoteName = "fleet-$Username"

function Invoke-Gh {
  param([string[]]$GhArgs)
  & $Gh @GhArgs
  if ($LASTEXITCODE -ne 0) {
    throw "gh failed: gh $($GhArgs -join ' ')"
  }
}

function Test-GhLoggedIn {
  & $Gh auth status -h github.com 2>&1 | Out-String | ForEach-Object {
    $_ -match "Logged in to github\.com"
  }
}

function Start-GhWebLogin {
  $loginArgs = @(
    "auth", "login", "-h", "github.com", "-p", "https", "-w",
    "-s", "repo", "-s", "workflow"
  )
  if ($IsWindows -or $env:OS -match "Windows") {
    $winArgs = @("/c", "start", "Fleet GitHub Login", $Gh) + $loginArgs
    Start-Process cmd.exe -ArgumentList $winArgs
  } else {
    Start-Process -FilePath $Gh -ArgumentList $loginArgs
  }
  Write-Host "Complete GitHub login in the browser (2FA on your machine), then press Enter here."
  [void][System.Console]::ReadLine()
}

function Read-SecretPlain {
  param([string]$Prompt)
  Write-Host $Prompt
  $secure = Read-Host -AsSecureString
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try {
    return [Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr).Trim()
  } finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) | Out-Null
  }
}

function Set-GhRepoSecretFromValue {
  param([string]$Name, [string]$Value, [string]$Repo)
  $utf8NoBom = New-Object System.Text.UTF8Encoding $false
  $tmp = Join-Path $env:TEMP ("fleet-secret-" + [guid]::NewGuid().ToString("n") + ".txt")
  try {
    [System.IO.File]::WriteAllText($tmp, $Value, $utf8NoBom)
    Get-Content -LiteralPath $tmp -Raw | & $Gh secret set $Name --repo $Repo
    if ($LASTEXITCODE -ne 0) { throw "gh secret set $Name failed" }
  } finally {
    Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
  }
}

Write-Host "Fleet setup — GitHub user: $Username"
Write-Host "Repo target: $RepoFull"

try {
  Invoke-Gh @("auth", "switch", "-u", $Username)
} catch {
  Write-Warning "Could not switch to $Username yet (login may be required)."
}

if (-not (Test-GhLoggedIn)) {
  Write-Host "Not logged in to github.com — opening web login."
  Start-GhWebLogin
  if (-not (Test-GhLoggedIn)) {
    throw "Still not logged in. Run gh auth login -w manually, then re-run this script."
  }
}

$viewOk = $true
& $Gh repo view $RepoFull --json name 1>$null 2>$null
if ($LASTEXITCODE -ne 0) { $viewOk = $false }

Push-Location -LiteralPath $RepoRoot
try {
  if (-not $viewOk) {
    Write-Host "Creating $RepoFull from current tree…"
    Invoke-Gh @(
      "repo", "create", $RepoFull,
      "--public",
      "--source", ".",
      "--remote", $RemoteName,
      "--push"
    )
  } else {
    $hasRemote = $false
    & git remote get-url $RemoteName 1>$null 2>$null
    if ($LASTEXITCODE -eq 0) { $hasRemote = $true }
    if (-not $hasRemote) {
      Invoke-Gh @("repo", "view", $RepoFull, "--json", "url") | Out-Null
      git remote add $RemoteName "https://github.com/$RepoFull.git"
    }
    git push $RemoteName HEAD:main
    if ($LASTEXITCODE -ne 0) {
      git push $RemoteName HEAD:master
    }
  }
} finally {
  Pop-Location
}

$tsKey = Read-SecretPlain "Paste Tailscale auth key (Reusable). Input is hidden."
if ($tsKey.Length -lt 20) { throw "Tailscale key too short or empty." }

$agentToken = Read-SecretPlain "Paste FLEET_AGENT_TOKEN (long random string). Input is hidden."
if ($agentToken.Length -lt 16) { throw "FLEET_AGENT_TOKEN too short or empty." }

Set-GhRepoSecretFromValue -Name "TAILSCALE_AUTH_KEY" -Value $tsKey -Repo $RepoFull
Set-GhRepoSecretFromValue -Name "FLEET_AGENT_TOKEN" -Value $agentToken -Repo $RepoFull

Write-Host "TERMINAL_SSH_PASSWORD for terminal-fleet-alpine.yml (Enter = agkalitsa, same as RDP workflows)."
$sshPlain = Read-Host
if (-not $sshPlain) { $sshPlain = "agkalitsa" }
if ($sshPlain.Length -lt 4) { throw "TERMINAL_SSH_PASSWORD too short or empty." }
Set-GhRepoSecretFromValue -Name "TERMINAL_SSH_PASSWORD" -Value $sshPlain -Repo $RepoFull

if (-not (Test-Path -LiteralPath $ExampleConfig)) {
  throw "Missing $ExampleConfig"
}

$template = Get-Content -LiteralPath $ExampleConfig -Raw -Encoding UTF8
if ($template.Length -gt 0 -and [int][char]$template[0] -eq 0xFEFF) {
  $template = $template.Substring(1)
}
$cfg = $template | ConvertFrom-Json

$primary = $cfg.github_accounts | Where-Object { $_.name -eq "primary" } | Select-Object -First 1
if (-not $primary) {
  $primary = [pscustomobject]@{
    name                 = "primary"
    token_env            = "GH_TOKEN_PRIMARY"
    gh_host              = "github.com"
    repos                = @($RepoFull)
    machines_per_account = 8
    secrets_note         = "Repo needs TAILSCALE_AUTH_KEY, FLEET_AGENT_TOKEN, TERMINAL_SSH_PASSWORD"
  }
  $cfg.github_accounts = @($primary) + @($cfg.github_accounts)
}

$primary | Add-Member -NotePropertyName enabled -NotePropertyValue $true -Force
$primary.repos = @($RepoFull)
$primary.gh_host = "github.com"
if (-not $primary.token_env) { $primary | Add-Member -NotePropertyName token_env -NotePropertyValue "GH_TOKEN_PRIMARY" -Force }

foreach ($acct in $cfg.github_accounts) {
  if ($acct.name -ne "primary") {
    $acct | Add-Member -NotePropertyName enabled -NotePropertyValue $false -Force
  }
}

$cfg.fleet_agent_token = $agentToken

$json = $cfg | ConvertTo-Json -Depth 10
$utf8NoBom = New-Object System.Text.UTF8Encoding $false
[System.IO.File]::WriteAllText($FleetConfig, $json, $utf8NoBom)

Write-Host "OK: secrets set on $RepoFull"
Write-Host "OK: wrote $FleetConfig (primary -> $RepoFull, other accounts disabled)"
Write-Host "Next: cd fleet-control; npm run gui — then Provision with account primary."
