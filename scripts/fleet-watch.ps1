# One-shot auto-reconnect for schedulers / Cursor Automations.
# Wraps: gh auth switch → node cli.js watch --once → optional poll.
#
# Usage:
#   .\scripts\fleet-watch.ps1
#   .\scripts\fleet-watch.ps1 -Poll -PollMinutes 15
#   .\scripts\fleet-watch.ps1 -DryRun
param(
  [int]$Target = 8,
  [string]$GhUser = "lifeownerteam",
  [switch]$Poll,
  [int]$PollMinutes = 15,
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$FleetDir = Join-Path $RepoRoot "fleet-control"
$Cli = Join-Path $FleetDir "cli.js"
$FleetPs1 = Join-Path $RepoRoot "scripts\fleet.ps1"
$Lifeowner = Join-Path $RepoRoot "scripts\auto-fleet-lifeownerteam.ps1"

if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
  Write-Error "GitHub CLI (gh) is required on PATH."
  exit 1
}
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Error "Node.js is required on PATH."
  exit 1
}
if (-not (Test-Path -LiteralPath $Cli)) {
  Write-Error "Missing $Cli"
  exit 1
}

Write-Host "=== fleet-watch (one shot, target=$Target) ==="
Write-Host "gh auth switch -u $GhUser"
& gh auth switch -u $GhUser 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) {
  Write-Error "gh auth switch -u $GhUser failed — run gh auth login first."
  exit 1
}

$nodeArgs = @("watch", "--once", "--target", "$Target")
if ($DryRun) { $nodeArgs += "--dry-run" }

Push-Location $FleetDir
try {
  & node $Cli @nodeArgs
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} finally {
  Pop-Location
}

if ($Poll -and -not $DryRun) {
  Write-Host "Optional poll ($PollMinutes min)…"
  if (Test-Path -LiteralPath $Lifeowner) {
    & $Lifeowner -PollOnly -Poll -PollMinutes $PollMinutes -TargetCount $Target -GhUser $GhUser
  } else {
    & $FleetPs1 poll $Target
  }
}

Write-Host ""
& $FleetPs1 status
Write-Host "=== fleet-watch done ==="
