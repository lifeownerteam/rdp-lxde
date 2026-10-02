# Wrapper for fleet-control CLI (Node.js) and local setup helpers
param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$Args
)

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = Split-Path -Parent $Root
$Cli = Join-Path $Root "cli.js"

if ($Args.Count -gt 0 -and $Args[0] -eq "setup-account") {
  $Setup = Join-Path $RepoRoot "scripts\setup-account.ps1"
  if (-not (Test-Path -LiteralPath $Setup)) {
    Write-Error "Missing $Setup"
    exit 1
  }
  $setupArgs = @()
  if ($Args.Count -gt 1) {
    $setupArgs = $Args[1..($Args.Count - 1)]
  }
  & $Setup @setupArgs
  exit $LASTEXITCODE
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Error "Node.js is required on PATH."
  exit 1
}

& node $Cli @Args
exit $LASTEXITCODE
