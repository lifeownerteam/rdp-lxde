# One command: sync secrets, provision 8× LXDE, poll artifacts, refresh fleet state.
# Usage: .\scripts\auto-fleet.ps1 [-SkipPoll] [-PollMinutes 12] [-Repo lifeownerteam/rdp-lxde]
param(
  [switch]$SkipPoll,
  [int]$PollMinutes = 12,
  [string]$Repo = "lifeownerteam/rdp-lxde",
  [string]$Gh = "D:\Tools\gh\bin\gh.exe"
)

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$Lifeowner = Join-Path $RepoRoot "scripts\auto-fleet-lifeownerteam.ps1"

if (-not (Test-Path -LiteralPath $Lifeowner)) {
  Write-Error "Missing $Lifeowner"
  exit 1
}

if (-not (Test-Path -LiteralPath $Gh)) { $Gh = "gh" }

& $Gh auth switch -u ($Repo.Split("/")[0]) | Out-Null
if ($LASTEXITCODE -ne 0) { throw "gh auth switch failed for $Repo" }

$pollArgs = @()
if (-not $SkipPoll) {
  $pollArgs = @("-Poll", "-PollMinutes", $PollMinutes)
}

& $Lifeowner -Repo $Repo -Gh $Gh @pollArgs
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

if ($SkipPoll) { exit 0 }

$FleetPs1 = Join-Path $RepoRoot "fleet-control\fleet.ps1"
if (Test-Path -LiteralPath $FleetPs1) {
  Write-Host "Refreshing fleet-state from artifacts…"
  & $FleetPs1 refresh
  if ($LASTEXITCODE -ne 0) {
    Write-Warning "fleet refresh exited $LASTEXITCODE (IPs may still be in poll output)"
  }
}
