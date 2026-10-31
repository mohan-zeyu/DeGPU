param([int]$Port=8701, [string]$Profile='alice', [string]$Network, [string]$BlenderPath)
& (Join-Path $PSScriptRoot 'Start-App.ps1') -Port $Port -Profile $Profile -Network $Network -BlenderPath $BlenderPath
