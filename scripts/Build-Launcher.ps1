$ErrorActionPreference = 'Stop'
$appRoot = Split-Path -Parent $PSScriptRoot
$exe = Join-Path $appRoot 'DeGPU-Launcher.exe'
try {
    if (-not (Test-Path -LiteralPath $exe)) {
        $compiler = Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
        $automation = [System.Management.Automation.PowerShell].Assembly.Location
        $result = & $compiler /nologo /target:winexe (('/out:' + $exe)) (('/reference:' + $automation)) /reference:System.Windows.Forms.dll (Join-Path $PSScriptRoot 'LauncherHost.cs') 2>&1
        if ($LASTEXITCODE -ne 0) { throw ($result -join [Environment]::NewLine) }
    }
    Start-Process -FilePath $exe
} catch {
    Add-Type -AssemblyName System.Windows.Forms
    [void][Windows.Forms.MessageBox]::Show($_.Exception.Message, 'DeGPU 启动提示')
}
