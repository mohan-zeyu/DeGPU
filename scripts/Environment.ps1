$ErrorActionPreference = 'Stop'
$script:DeGpuRoot = Split-Path -Parent $PSScriptRoot
$env:PYTHONUTF8 = '1'
$env:PATH = (Join-Path $script:DeGpuRoot '.tools/bin') + [IO.Path]::PathSeparator + (Join-Path $script:DeGpuRoot '.tools') + [IO.Path]::PathSeparator + $env:PATH
$localBlender = Join-Path $script:DeGpuRoot '.tools/blender-5.2.3-windows-x64/blender.exe'
if (-not $env:DEGPU_BLENDER -and (Test-Path -LiteralPath $localBlender)) { $env:DEGPU_BLENDER = $localBlender }
$script:DeGpuPython = Join-Path $script:DeGpuRoot '.venv/Scripts/python.exe'
function Assert-DeGpuInstalled {
    if (-not (Test-Path -LiteralPath $script:DeGpuPython)) { throw 'Run Install-DeGPU.ps1 first.' }
}
function Assert-FreePort([int]$Port) {
    if ($Port -lt 1024 -or $Port -gt 65535) { throw 'Port must be between 1024 and 65535.' }
    if ([Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners() | Where-Object Port -eq $Port) {
        throw "Port $Port is already in use. Choose a different port; existing services were not changed."
    }
}
