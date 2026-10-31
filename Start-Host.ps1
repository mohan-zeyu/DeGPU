param(
    [ValidatePattern('^[A-Za-z0-9_-]{1,32}$')][string]$NetworkName = 'classroom',
    [int]$Port = 8600,
    [string]$BindAddress = '0.0.0.0'
)
. (Join-Path $PSScriptRoot 'scripts/Environment.ps1')
Assert-DeGpuInstalled
Assert-FreePort $Port
if (-not (Get-Command anvil -ErrorAction SilentlyContinue)) { throw 'Host requires Anvil: run Install-DeGPU.ps1 -Role Host.' }
$networkDir = Join-Path $PSScriptRoot ".local/networks/$NetworkName"
Write-Host "Host data: $networkDir"
Write-Host "Participants connect to http://<HOST-LAN-IP>:$Port. Keep this terminal open."
Push-Location $PSScriptRoot
try { & $script:DeGpuPython -m degpu.cli host --dir $networkDir --port $Port --bind $BindAddress; if ($LASTEXITCODE -ne 0) { throw "Host exited with code $LASTEXITCODE" } }
finally { Pop-Location }
