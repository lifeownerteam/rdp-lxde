# Set TAILSCALE_AUTH_KEY without trailing newline (breaks tailscale up).
# Usage: .\set-tailscale-github-secret.ps1 -Repo jacobivan988-cmd/dwadwaadw
param(
  [Parameter(Mandatory = $true)]
  [string]$Repo,
  [string]$Gh = "D:\Tools\gh\bin\gh.exe"
)

if (-not (Test-Path -LiteralPath $Gh)) { $Gh = "gh" }

Write-Host "Paste Tailscale auth key (Reusable, not Ephemeral). Input is hidden."
$secure = Read-Host -AsSecureString
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try {
  $key = [Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr).Trim()
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) | Out-Null
}

if ($key.Length -lt 20) {
  Write-Error "Key too short or empty."
  exit 1
}

$utf8NoBom = New-Object System.Text.UTF8Encoding $false
[System.IO.File]::WriteAllText("$env:TEMP\tskey-one-line.txt", $key, $utf8NoBom)
try {
  Get-Content -LiteralPath "$env:TEMP\tskey-one-line.txt" -Raw | & $Gh secret set TAILSCALE_AUTH_KEY --repo $Repo
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  Write-Host "OK: TAILSCALE_AUTH_KEY updated on $Repo"
} finally {
  Remove-Item -LiteralPath "$env:TEMP\tskey-one-line.txt" -Force -ErrorAction SilentlyContinue
}
