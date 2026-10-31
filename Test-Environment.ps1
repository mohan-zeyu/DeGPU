param([switch]$HostRole)
. (Join-Path $PSScriptRoot 'scripts/Environment.ps1')
Assert-DeGpuInstalled
Push-Location $PSScriptRoot
try {
    & $script:DeGpuPython (Join-Path $PSScriptRoot 'scripts/check_environment.py')
    if ($LASTEXITCODE -ne 0) { throw 'Required environment checks failed.' }
    if ($HostRole -and -not (Get-Command anvil -ErrorAction SilentlyContinue)) { throw 'Host requires Anvil. Run Install-DeGPU.ps1 -Role Host.' }
    if ($HostRole) { & anvil --version }
} finally { Pop-Location }
