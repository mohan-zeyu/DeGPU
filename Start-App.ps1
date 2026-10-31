param(
    [ValidatePattern('^[A-Za-z0-9_-]{1,32}$')][string]$Profile = 'alice',
    [int]$Port = 8701,
    [string]$Network,
    [string]$BlenderPath
)
. (Join-Path $PSScriptRoot 'scripts/Environment.ps1')
Assert-DeGpuInstalled
Assert-FreePort $Port
if ($BlenderPath) { $env:DEGPU_BLENDER = $BlenderPath }
$env:DEGPU_HOME = Join-Path $PSScriptRoot ".local/profiles/$Profile"
$cliArgs = @('-m', 'degpu.cli', 'app', '--locked', '--port', "$Port")
if ($Network) { $cliArgs += @('--network', $Network.TrimEnd('/')) }
Write-Host "Open http://127.0.0.1:$Port in this computer's browser. Profile: $Profile"
Write-Host 'Keep this terminal open. Blender is optional. Press Ctrl+C to stop.'
Push-Location $PSScriptRoot
try { & $script:DeGpuPython @cliArgs; if ($LASTEXITCODE -ne 0) { throw "App exited with code $LASTEXITCODE" } }
finally { Pop-Location }
