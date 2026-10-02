# Wrapper for fleet-control CLI (Node.js)
param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$Args
)

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Cli = Join-Path $Root "cli.js"

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Error "Node.js is required on PATH."
  exit 1
}

& node $Cli @Args
exit $LASTEXITCODE
