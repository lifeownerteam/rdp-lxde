# Back-compat shim - prefer repo root: ..\scripts\fleet.ps1
param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$Args
)

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = Split-Path -Parent $Root
$Wrapper = Join-Path $RepoRoot "scripts\fleet.ps1"

if ($Args.Count -gt 0 -and $Args[0] -eq "setup-account") {
  $mapped = @("setup") + $Args[1..($Args.Count - 1)]
  & $Wrapper @mapped
  exit $LASTEXITCODE
}

if (-not (Test-Path -LiteralPath $Wrapper)) {
  Write-Error "Missing $Wrapper - run from repo with scripts/fleet.ps1"
  exit 1
}

if ($Args.Count -eq 0) {
  & $Wrapper help
  exit $LASTEXITCODE
}

$cmd = $Args[0]
$rest = @()
if ($Args.Count -gt 1) { $rest = $Args[1..($Args.Count - 1)] }

switch ($cmd) {
  "provision" { & $Wrapper provision @rest; exit $LASTEXITCODE }
  "provision-fleet" { & $Wrapper provision 80 @rest; exit $LASTEXITCODE }
  "refresh" { & $Wrapper refresh @rest; exit $LASTEXITCODE }
  "status" { & $Wrapper status @rest; exit $LASTEXITCODE }
  "clean-queue" { & $Wrapper clean-queue @rest; exit $LASTEXITCODE }
  "poll" { & $Wrapper poll @rest; exit $LASTEXITCODE }
  "gui" { & $Wrapper gui @rest; exit $LASTEXITCODE }
  "secrets" { & $Wrapper secrets @rest; exit $LASTEXITCODE }
  "setup" { & $Wrapper setup @rest; exit $LASTEXITCODE }
}

$Cli = Join-Path $Root "cli.js"
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Error "Node.js is required on PATH."
  exit 1
}
& node $Cli @Args
exit $LASTEXITCODE
