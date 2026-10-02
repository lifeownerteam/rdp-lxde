# Set FLEET_AGENT_TOKEN (same value as fleet-control/config.json fleet_agent_token).
# Usage: .\set-fleet-agent-github-secret.ps1 -Repo OWNER/REPO
param(
  [Parameter(Mandatory = $true)]
  [string]$Repo,
  [string]$Gh = "D:\Tools\gh\bin\gh.exe"
)

if (-not (Test-Path -LiteralPath $Gh)) { $Gh = "gh" }

Write-Host "Paste fleet agent token (long random string). Input is hidden."
$secure = Read-Host -AsSecureString
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try {
  $key = [Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr).Trim()
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) | Out-Null
}

if ($key.Length -lt 16) {
  Write-Error "Token too short or empty."
  exit 1
}

$utf8NoBom = New-Object System.Text.UTF8Encoding $false
[System.IO.File]::WriteAllText("$env:TEMP\fleet-agent-token.txt", $key, $utf8NoBom)
try {
  Get-Content -LiteralPath "$env:TEMP\fleet-agent-token.txt" -Raw | & $Gh secret set FLEET_AGENT_TOKEN --repo $Repo
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  Write-Host "OK: FLEET_AGENT_TOKEN updated on $Repo"
} finally {
  Remove-Item -LiteralPath "$env:TEMP\fleet-agent-token.txt" -Force -ErrorAction SilentlyContinue
}
