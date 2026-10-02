# Tailscale secret (once), queue-aware dispatch, optional poll for tailscale-ip artifacts.
# API key (never printed): fleet-control/.tailscale-api-key OR $env:TAILSCALE_API_KEY OR $env:TS_API_KEY_MAIN
#
# Usage:
#   .\scripts\auto-fleet-lifeownerteam.ps1              # ensure secret, dispatch missing to 8
#   .\scripts\auto-fleet-lifeownerteam.ps1 -PollOnly    # only poll artifacts (no secret, no dispatch)
#   .\scripts\auto-fleet-lifeownerteam.ps1 -Poll -PollMinutes 20
param(
  [switch]$PollOnly,
  [switch]$Poll,
  [int]$PollMinutes = 15,
  [int]$TargetCount = 8,
  [string]$Gh = "D:\Tools\gh\bin\gh.exe",
  [string]$Repo = "lifeownerteam/rdp-lxde",
  [string]$Workflow = "rdp-alpine-openbox.yml",
  [string]$WorkflowName = "RDP Linux Desktop (LXDE)",
  [string]$GhUser = "lifeownerteam"
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path -LiteralPath $Gh)) { $Gh = "gh" }

$RepoRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$KeyFile = Join-Path $RepoRoot "fleet-control\.tailscale-api-key"

function Get-TsApiKey {
  if (Test-Path -LiteralPath $KeyFile) {
    $line = (Get-Content -LiteralPath $KeyFile -ErrorAction SilentlyContinue |
      Where-Object { $_ -and $_ -notmatch '^\s*#' }) | Select-Object -First 1
    if ($line) {
      $t = $line.Trim().Trim('"').Trim("'")
      if ($t.Length -gt 10) { return $t }
    }
  }
  if ($env:TAILSCALE_API_KEY -and $env:TAILSCALE_API_KEY.Length -gt 10) {
    return $env:TAILSCALE_API_KEY.Trim()
  }
  if ($env:TS_API_KEY_MAIN -and $env:TS_API_KEY_MAIN.Length -gt 10) {
    return $env:TS_API_KEY_MAIN.Trim()
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
    if ($LASTEXITCODE -ne 0) { throw "gh secret set $Name failed" }
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
    description   = "lifeownerteam-rdp-lxde"
    expirySeconds = 7776000
  } | ConvertTo-Json -Depth 6 -Compress

  $keyResp = Invoke-RestMethod -Uri "https://api.tailscale.com/api/v2/tailnet/-/keys" `
    -Headers $headers -Method Post -Body $body
  $authKey = $keyResp.key
  if (-not $authKey) { throw "Tailscale API did not return auth key" }
  return [string]$authKey
}

function Get-ActiveWorkflowCount {
  param([string]$TargetRepo, [string]$WorkflowFile, [int]$Limit = 30)
  $recent = & $Gh run list --repo $TargetRepo --workflow $WorkflowFile --limit $Limit `
    --json databaseId, status | ConvertFrom-Json
  if (-not $recent) { return 0 }
  $active = @($recent | Where-Object { $_.status -in @("queued", "in_progress", "waiting", "pending") })
  return $active.Count
}

& $Gh auth switch -u $GhUser | Out-Null
if ($LASTEXITCODE -ne 0) { throw "gh auth switch -u $GhUser failed" }

if ($PollOnly) {
  $Poll = $true
  Write-Host "PollOnly: skipping Tailscale secret and workflow dispatch."
} else {
  $hasSecret = Test-GhRepoSecret -TargetRepo $Repo -SecretName "TAILSCALE_AUTH_KEY"
  if ($hasSecret) {
    Write-Host "TAILSCALE_AUTH_KEY already on $Repo — not creating a new auth key."
  } else {
    $apiKey = Get-TsApiKey
    if (-not $apiKey) {
      Write-Error @"
No Tailscale API key. Save tskey-api-… once to:
  $KeyFile
(or set `$env:TAILSCALE_API_KEY / `$env:TS_API_KEY_MAIN in this shell).
"@
      exit 2
    }
    Write-Host "Tailscale API key: loaded (not shown)"
    Write-Host "Creating reusable preauthorized auth key…"
    $authKey = New-TailscaleAuthKey -ApiKey $apiKey
    Write-Host "Auth key: created (not shown)"
    Set-GhRepoSecretFromValue -Name "TAILSCALE_AUTH_KEY" -Value $authKey -TargetRepo $Repo
    Write-Host "OK: TAILSCALE_AUTH_KEY set on $Repo"
  }

  $active = Get-ActiveWorkflowCount -TargetRepo $Repo -WorkflowFile $Workflow
  $toDispatch = [Math]::Max(0, $TargetCount - $active)
  Write-Host "Queue check: $active active, target $TargetCount → dispatch $toDispatch"
  if ($toDispatch -gt 0) {
    Write-Host "Dispatching $toDispatch× $Workflow…"
    1..$toDispatch | ForEach-Object {
      & $Gh workflow run $Workflow --repo $Repo --ref main 2>&1 | Out-Null
      if ($LASTEXITCODE -ne 0) { throw "workflow dispatch $_/$toDispatch failed" }
      Write-Host "  dispatched $_/$toDispatch"
      Start-Sleep -Milliseconds 800
    }
  } else {
    Write-Host "No dispatch needed (already at target active runs)."
  }
}

if (-not $Poll) {
  Write-Host "Done (no poll). Re-run with -Poll or -PollOnly to wait for tailscale-ip artifacts."
  exit 0
}

Write-Host "Polling up to $PollMinutes min for tailscale-ip artifacts…"
$deadline = (Get-Date).AddMinutes($PollMinutes)
$found = @{}
while ((Get-Date) -lt $deadline) {
  & $Gh auth switch -u $GhUser | Out-Null
  $ghToken = & $Gh auth token
  $recent = & $Gh run list -R $Repo -w $WorkflowName --limit 12 `
    --json "databaseId,status,conclusion,createdAt" | ConvertFrom-Json
  foreach ($run in $recent) {
    if ($found.ContainsKey($run.databaseId)) { continue }
    $artJson = & $Gh api "repos/$Repo/actions/runs/$($run.databaseId)/artifacts?per_page=20" 2>$null |
      ConvertFrom-Json
    $art = ($artJson.artifacts | Where-Object { $_.name -eq "tailscale-ip" } | Select-Object -First 1)
    if (-not $art) { continue }
    $zipPath = Join-Path $env:TEMP ("ts-ip-$($run.databaseId).zip")
    $extractDir = Join-Path $env:TEMP ("ts-ip-$($run.databaseId)-dir")
    try {
      $zipUri = "https://api.github.com/repos/$Repo/actions/artifacts/$($art.id)/zip"
      Invoke-WebRequest -Uri $zipUri -Headers @{
        Authorization            = "Bearer $ghToken"
        Accept                   = "application/vnd.github+json"
        "X-GitHub-Api-Version"   = "2022-11-28"
      } -OutFile $zipPath
      if (Test-Path -LiteralPath $zipPath) {
        Add-Type -AssemblyName System.IO.Compression.FileSystem -ErrorAction SilentlyContinue
        if (Test-Path $extractDir) { Remove-Item $extractDir -Recurse -Force }
        New-Item -ItemType Directory -Path $extractDir | Out-Null
        [System.IO.Compression.ZipFile]::ExtractToDirectory($zipPath, $extractDir)
        $ipFile = Get-ChildItem -Path $extractDir -Recurse -Filter "tailscale-ip.txt" -ErrorAction SilentlyContinue |
          Select-Object -First 1
        if ($ipFile) {
          $ip = (Get-Content -LiteralPath $ipFile.FullName -Raw).Trim()
          if ($ip -match '^\d+\.\d+\.\d+\.\d+$') {
            $found[$run.databaseId] = $ip
            Write-Host "  $($ip):3389 (run $($run.databaseId) $($run.status))"
          }
        }
        Remove-Item $extractDir -Recurse -Force -ErrorAction SilentlyContinue
      }
    } finally {
      Remove-Item -LiteralPath $zipPath -Force -ErrorAction SilentlyContinue
    }
  }
  if ($found.Count -ge $TargetCount) { break }
  Write-Host "  have $($found.Count)/$TargetCount IPs, waiting…"
  Start-Sleep -Seconds 30
}

Write-Host "Poll complete: $($found.Count)/$TargetCount with tailscale-ip"
$found.Values | Sort-Object -Unique | ForEach-Object { Write-Host "RDP $_:3389" }
