param(
    [ValidateSet('Participant','Host')][string]$Role = 'Participant',
    [switch]$WithBlender,
    [switch]$Dev
)
$ErrorActionPreference = 'Stop'
if (-not [Environment]::Is64BitOperatingSystem -or $env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { throw 'This installer targets Windows x64.' }
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$ProgressPreference = 'SilentlyContinue'
$cacheDir = Join-Path $PSScriptRoot '.downloads'
$toolsDir = Join-Path $PSScriptRoot '.tools'
New-Item -ItemType Directory -Path $cacheDir,$toolsDir -Force | Out-Null
function Get-VerifiedZip([string]$Name, [string]$Url, [string]$Sha256) {
    $file = Join-Path $cacheDir $Name
    if (Test-Path -LiteralPath $file) {
        if ((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash -ne $Sha256) { throw "Cached file failed checksum: $file. Remove only that file and retry." }
    } else {
        Write-Host "Downloading $Name ..."
        $partial = $file + '.partial'
        $curl = Get-Command curl.exe -ErrorAction SilentlyContinue
        if ($curl) {
            & $curl.Source -fL --retry 3 --connect-timeout 30 -o $partial $Url
            if ($LASTEXITCODE -ne 0) { throw "Download failed: $Url" }
        } else { Invoke-WebRequest -Uri $Url -OutFile $partial -UseBasicParsing }
        if ((Get-FileHash -LiteralPath $partial -Algorithm SHA256).Hash -ne $Sha256) { throw "Downloaded file failed checksum: $partial" }
        Move-Item -LiteralPath $partial -Destination $file -Force
    }
    return $file
}
Write-Host 'Install Python dependencies. Blender is optional and not needed for other services.'
$uvZip = Get-VerifiedZip 'uv-windows.zip' 'https://github.com/astral-sh/uv/releases/download/0.13.5/uv-x86_64-pc-windows-msvc.zip' 'a38b8d1902b7cfbc76b423ba1bb456f623f42064cdc72628b6075b89afd1019a'
Expand-Archive -LiteralPath $uvZip -DestinationPath $toolsDir -Force
$uv = Join-Path $toolsDir 'uv.exe'
if (-not (Test-Path -LiteralPath $uv)) { throw 'uv.exe missing after archive extraction.' }
$env:PYTHONUTF8 = '1'
$env:UV_PYTHON_INSTALL_DIR = Join-Path $toolsDir 'python'
$env:UV_CACHE_DIR = Join-Path $cacheDir 'uv-cache'
& $uv python install 3.12.5 --no-bin --no-registry
if ($LASTEXITCODE -ne 0) { throw 'Local Python 3.12.5 installation failed.' }
$syncArgs = @('sync', '--locked', '--python', '3.12.5', '--managed-python')
if (-not $Dev) { $syncArgs += '--no-dev' }
Push-Location $PSScriptRoot
try { & $uv @syncArgs; if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed. Check network access to Python downloads and PyPI.' } }
finally { Pop-Location }
if ($Role -eq 'Host' -or $Dev) {
    $foundryZip = Get-VerifiedZip 'foundry-windows.zip' 'https://github.com/foundry-rs/foundry/releases/download/v1.8.6/foundry_v1.8.6_win32_amd64.zip' '924d6395786af438e7cb315f6835185f99d727ed6127dbbc4e6a62eb14edcfff'
    $anvil = Join-Path $toolsDir 'bin/anvil.exe'
    $forge = Join-Path $toolsDir 'bin/forge.exe'
    $foundryReady = $false
    if ((Test-Path -LiteralPath $anvil) -and (Test-Path -LiteralPath $forge)) {
        $foundryReady = ((& $anvil --version | Out-String) -match 'Version: 1\.8\.6') -and ((& $forge --version | Out-String) -match 'Version: 1\.8\.6')
    }
    if ($foundryReady) { Write-Host 'Foundry 1.8.6 already installed; keeping existing binaries.' }
    else { Expand-Archive -LiteralPath $foundryZip -DestinationPath (Join-Path $toolsDir 'bin') -Force }
}
if ($WithBlender) {
    & (Join-Path $PSScriptRoot 'Install-Blender.ps1')
}
Write-Host 'Installation complete. Run Test-Environment.ps1, then Start-App.ps1 (and Start-Host.ps1 on the host).'
