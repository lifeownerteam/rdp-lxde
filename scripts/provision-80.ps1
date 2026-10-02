# Dispatch up to target_total (default 80) across enabled accounts in fleet-control config.
# Uses gh auth switch per account (gh_user) then provision-fleet for that account only.
# Does not rotate TAILSCALE_AUTH_KEY when the repo secret already exists.
#
# Usage:
#   .\scripts\provision-80.ps1
#   .\scripts\provision-80.ps1 -CancelDuplicates
#   .\scripts\provision-80.ps1 -ConfigPath fleet-control\config.json
param(
  [switch]$CancelDuplicates,
  [string]$ConfigPath = "",
  [string]$Gh = "D:\Tools\gh\bin\gh.exe",
  [string]$FleetCli = ""
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path -LiteralPath $Gh)) { $Gh = "gh" }

$RepoRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$FleetDir = Join-Path $RepoRoot "fleet-control"

if (-not $ConfigPath) {
  $localCfg = Join-Path $FleetDir "config.json"
  $exampleCfg = Join-Path $FleetDir "config.example.json"
  if (Test-Path -LiteralPath $localCfg) { $ConfigPath = $localCfg }
  else { $ConfigPath = $exampleCfg }
}

if (-not $FleetCli) { $FleetCli = Join-Path $FleetDir "cli.js" }
if (-not (Test-Path -LiteralPath $FleetCli)) { throw "Missing $FleetCli" }
if (-not (Test-Path -LiteralPath $ConfigPath)) { throw "Missing config: $ConfigPath" }

$cfg = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
$accounts = @()
if ($cfg.accounts) { $accounts = @($cfg.accounts) }
elseif ($cfg.github_accounts) { $accounts = @($cfg.github_accounts) }

$enabled = @($accounts | Where-Object { $_.enabled -ne $false })
if (-not $enabled.Count) {
  Write-Error "No enabled accounts in $ConfigPath"
  exit 1
}

$targetTotal = [int]($cfg.target_total)
if (-not $targetTotal) { $targetTotal = 80 }

Write-Host "provision-80: $($enabled.Count) enabled account(s), target_total=$targetTotal"
Write-Host "Config: $ConfigPath"

function Test-GhRepoSecret {
  param([string]$Repo, [string]$SecretName)
  $names = & $Gh secret list --repo $Repo --json name 2>$null | ConvertFrom-Json
  if (-not $names) { return $false }
  return [bool](@($names) | Where-Object { $_.name -eq $SecretName })
}

$env:FLEET_CONFIG = $ConfigPath

foreach ($acct in $enabled) {
  $ghUser = $acct.gh_user
  if (-not $ghUser -and $acct.repos -and $acct.repos.Count -gt 0) {
    $ghUser = ($acct.repos[0] -split "/")[0]
  }
  if ($ghUser) {
    Write-Host "`n=== account $($acct.name) (gh switch $ghUser) ==="
    & $Gh auth switch -u $ghUser | Out-Null
    if ($LASTEXITCODE -ne 0) {
      Write-Warning "gh auth switch -u $ghUser failed — skip $($acct.name)"
      continue
    }
  } else {
    Write-Host "`n=== account $($acct.name) (no gh_user; using token_env / current gh) ==="
  }

  foreach ($repo in @($acct.repos)) {
    if ($repo -match "YOUR_|OTHER_ORG|example\.com") { continue }
    $hasTs = Test-GhRepoSecret -Repo $repo -SecretName "TAILSCALE_AUTH_KEY"
    if ($hasTs) {
      Write-Host "  $repo : TAILSCALE_AUTH_KEY present — not rotating"
    } else {
      Write-Host "  $repo : TAILSCALE_AUTH_KEY missing — run setup-account or auto-fleet script first"
    }
  }

  $cliArgs = @($FleetCli, "provision-fleet", "--account", $acct.name, "--total", "$targetTotal")
  if ($CancelDuplicates) { $cliArgs += "--cancel-duplicates" }

  & node @cliArgs
  if ($LASTEXITCODE -ne 0) {
    Write-Warning "provision-fleet failed for $($acct.name) (exit $LASTEXITCODE)"
  }
}

Write-Host "`nDone. Run fleet refresh or auto-fleet with -PollOnly to collect IPs."
