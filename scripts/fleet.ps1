# Self-service fleet wrapper (no AI required). Reads fleet-control/config.json + .tailscale-api-key
# Usage:
#   .\scripts\fleet.ps1 setup -Username YOUR_GITHUB_USER
#   .\scripts\fleet.ps1 secrets
#   .\scripts\fleet.ps1 clean-queue
#   .\scripts\fleet.ps1 provision [8|80|N]
#   .\scripts\fleet.ps1 poll [N]
#   .\scripts\fleet.ps1 status [-Json]
#   .\scripts\fleet.ps1 gui
param(
  [Parameter(Position = 0)]
  [ValidateSet("setup", "secrets", "clean-queue", "provision", "poll", "status", "gui", "refresh", "watch", "help")]
  [string]$Command = "help",

  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$Rest = @()
)

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$FleetDir = Join-Path $RepoRoot "fleet-control"
$Cli = Join-Path $FleetDir "cli.js"

function Invoke-FleetNode {
  param([string[]]$NodeArgs)
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Error "Node.js is required on PATH."
    exit 1
  }
  & node $Cli @NodeArgs
  exit $LASTEXITCODE
}

switch ($Command) {
  "help" {
    Write-Host @"
Fleet self-service (from repo root)

  .\scripts\fleet.ps1 setup -Username USER     # gh login + repo + local config (scripts\setup-account.ps1)
  .\scripts\fleet.ps1 secrets                  # TAILSCALE_AUTH_KEY + FLEET_AGENT_TOKEN + TERMINAL_SSH_PASSWORD
  .\scripts\fleet.ps1 clean-queue              # cancel queued/in_progress LXDE runs
  .\scripts\fleet.ps1 provision [8|80|N]       # dedupe dispatch toward target (80 = multi-account fleet)
  .\scripts\fleet.ps1 poll [N]                 # refresh artifacts until N IPs or timeout
  .\scripts\fleet.ps1 status [-Json]           # IPs table + gh accounts check
  .\scripts\fleet.ps1 refresh                  # one-shot IP refresh
  .\scripts\fleet.ps1 watch [--target 8] [--interval 120] [--once] [--dry-run]
  .\scripts\fleet-watch.ps1 [-Poll]              # gh switch + watch --once (for Automations)
  .\scripts\fleet.ps1 gui                      # npm run gui (unchanged dashboard)
  node fleet-control\cli.js cluster health     # parallel health on all LIVE agents
  node fleet-control\cli.js cluster exec "cmd" # run shell on entire fleet

Terminal-only workflow: set workflow_id to terminal-fleet-alpine.yml (see TERMINAL-FLEET-EL.md).

Config: fleet-control\config.json
Tailscale API: fleet-control\.tailscale-api-key (gitignored)
"@
    exit 0
  }
  "setup" {
    $setup = Join-Path $RepoRoot "scripts\setup-account.ps1"
    if (-not (Test-Path -LiteralPath $setup)) { Write-Error "Missing $setup"; exit 1 }
    & $setup @Rest
    exit $LASTEXITCODE
  }
  "secrets" {
    $sec = Join-Path $RepoRoot "scripts\fleet-secrets.ps1"
    if (-not (Test-Path -LiteralPath $sec)) { Write-Error "Missing $sec"; exit 1 }
    & $sec @Rest
    exit $LASTEXITCODE
  }
  "gui" {
    Push-Location $FleetDir
    try {
      npm run gui
      exit $LASTEXITCODE
    } finally {
      Pop-Location
    }
  }
  "provision" {
    $target = $null
    $restFlags = @()
    foreach ($a in $Rest) {
      if ($null -eq $target -and $a -match '^\d+$') { $target = $a }
      else { $restFlags += $a }
    }
    if ($target -eq "80") {
      $p80 = Join-Path $RepoRoot "scripts\provision-80.ps1"
      if (Test-Path -LiteralPath $p80) {
        $p80Args = @()
        foreach ($a in $Rest) { if ($a -eq "-CancelDuplicates") { $p80Args += "-CancelDuplicates" } }
        & $p80 @p80Args
        exit $LASTEXITCODE
      }
    }
    $nodeArgs = @("provision")
    if ($target) { $nodeArgs += @("--count", $target) }
    $nodeArgs += $restFlags
    Invoke-FleetNode $nodeArgs
  }
  "poll" {
    $nodeArgs = @("poll")
    if ($Rest.Count -gt 0 -and $Rest[0] -notmatch '^-') {
      $nodeArgs += $Rest[0]
      if ($Rest.Count -gt 1) { $nodeArgs += $Rest[1..($Rest.Count - 1)] }
    } else {
      $nodeArgs += $Rest
    }
    Invoke-FleetNode $nodeArgs
  }
  "status" {
    $nodeArgs = @("status") + $Rest
    foreach ($a in $Rest) {
      if ($a -eq "-Json" -or $a -eq "--json") { $nodeArgs = @("status", "--json"); break }
    }
    Invoke-FleetNode $nodeArgs
  }
  "clean-queue" { Invoke-FleetNode (@("clean-queue") + $Rest) }
  "refresh" { Invoke-FleetNode (@("refresh") + $Rest) }
  "watch" { Invoke-FleetNode (@("watch") + $Rest) }
}
