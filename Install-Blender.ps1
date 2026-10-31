# Optional renderer only. Does not reinstall or downgrade Python dependencies.
$ErrorActionPreference = 'Stop'
$python = Join-Path $PSScriptRoot '.venv/Scripts/python.exe'
if (-not (Test-Path -LiteralPath $python)) { throw 'Run Install-DeGPU.ps1 first, then optionally install Blender.' }
$cacheDir = Join-Path $PSScriptRoot '.downloads'
New-Item -ItemType Directory -Path $cacheDir -Force | Out-Null
$file = Join-Path $cacheDir 'blender-5.2.3-windows-x64.zip'
$sha = '723f08a4401502561eb763cdeacf8745b31e5f3f154d287d3830d97cf75dc2fb'
if (-not (Test-Path -LiteralPath $file)) {
    $partial = $file + '.partial'
    & curl.exe -fL --retry 3 --connect-timeout 30 -o $partial 'https://download.blender.org/release/Blender5.2/blender-5.2.3-windows-x64.zip'
    if ($LASTEXITCODE -ne 0) { throw 'Blender download failed.' }
    if ((Get-FileHash -LiteralPath $partial -Algorithm SHA256).Hash -ne $sha) { throw 'Blender checksum mismatch.' }
    Move-Item -LiteralPath $partial -Destination $file -Force
}
if ((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash -ne $sha) { throw 'Cached Blender checksum mismatch.' }
& $python (Join-Path $PSScriptRoot 'scripts/extract_blender.py') $file (Join-Path $PSScriptRoot '.tools')
if ($LASTEXITCODE -ne 0) { throw 'Blender extraction failed. Check available disk space and close running copies of this local Blender.' }
Write-Host 'Blender installed. Restart provider apps, then check the rendering status in the frontend.'
