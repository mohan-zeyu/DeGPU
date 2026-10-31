param([string]$AppRoot, [ValidateSet('Show','Stop')][string]$Action = 'Show')
$ErrorActionPreference = 'Stop'
if (-not $AppRoot) { $AppRoot = Split-Path -Parent $PSScriptRoot }
$AppRoot = [IO.Path]::GetFullPath($AppRoot).TrimEnd([IO.Path]::DirectorySeparatorChar)
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()
$controlRoot = Join-Path $AppRoot '.local/launcher'
function Read-States {
    if (Test-Path -LiteralPath $controlRoot) {
        foreach ($file in Get-ChildItem -LiteralPath $controlRoot -Filter state.json -Recurse) {
            try { Get-Content -LiteralPath $file.FullName -Raw -Encoding UTF8 | ConvertFrom-Json } catch {}
        }
    }
}
function Notify([string]$text) { [void][Windows.Forms.MessageBox]::Show($text, 'DeGPU', 'OK', 'Information') }
if ($Action -eq 'Stop') {
    $active = @(Read-States | Where-Object { $_.status -in @('starting','ready','stopping') })
    foreach ($item in $active) {
        [IO.File]::WriteAllText((Join-Path $controlRoot ($item.session + '/STOP')), 'stop')
    }
    if ($active.Count) { Notify '已请求保存并停止。请等启动器显示“已停止”；钱包和网络数据会保留。' }
    else { Notify '当前没有由启动器运行的网络。' }
    exit
}
$mutex = New-Object Threading.Mutex($false, 'Local\DeGPUClassroomLauncher')
if (-not $mutex.WaitOne(0, $false)) { Notify 'DeGPU 启动器已经打开，请切换到该窗口。'; exit }
$script:proc = $null
$script:installProc = $null
$script:stateFile = $null
$script:pendingMode = $null
$script:phase = 'idle'
$script:autoOpened = $false
$script:closePending = $false
$form = New-Object Windows.Forms.Form
$form.Text = 'DeGPU · 区块链课程启动器'
$form.ClientSize = New-Object Drawing.Size(740, 590)
$form.StartPosition = 'CenterScreen'
$form.FormBorderStyle = 'FixedDialog'
$form.MaximizeBox = $false
$form.Font = New-Object Drawing.Font('Microsoft YaHei UI', 10)
function LabelAt($text,$x,$y,$width,$height) {
    $item = New-Object Windows.Forms.Label
    $item.Text = $text; $item.Location = New-Object Drawing.Point($x,$y)
    $item.Size = New-Object Drawing.Size($width,$height); $form.Controls.Add($item)
    return $item
}
function ButtonAt($text,$x,$y,$width,$handler) {
    $item = New-Object Windows.Forms.Button
    $item.Text = $text; $item.Location = New-Object Drawing.Point($x,$y)
    $item.Size = New-Object Drawing.Size($width,38); $item.Add_Click($handler)
    $form.Controls.Add($item); return $item
}
$title = LabelAt 'DeGPU 课程演示' 24 20 680 40
$title.Font = New-Object Drawing.Font('Microsoft YaHei UI', 18, [Drawing.FontStyle]::Bold)
$null = LabelAt '选择使用方式，点击启动。首次自动安装依赖；无需输入命令。' 24 65 680 30
$mode = New-Object Windows.Forms.ComboBox
$mode.DropDownStyle = 'DropDownList'
$mode.Location = New-Object Drawing.Point(24,110); $mode.Size = New-Object Drawing.Size(680,30)
[void]$mode.Items.AddRange(@('本机五人演示（1 位客户 + 4 位提供方）','普通使用（本机网络 + 1 位用户）','加入同学的网络（只启动自己的用户）','创建局域网（Host + 自己的用户）'))
$mode.SelectedIndex = 0; $form.Controls.Add($mode)
$null = LabelAt '数据组' 24 158 90 24
$session = New-Object Windows.Forms.TextBox
$session.Text = 'rec01'; $session.Location = New-Object Drawing.Point(114,155)
$session.Size = New-Object Drawing.Size(160,28); $form.Controls.Add($session)
$null = LabelAt '每次重新启动都会建立新链；旧链记录保留。' 290 158 414 25
$null = LabelAt '网络地址' 24 200 90 25
$network = New-Object Windows.Forms.TextBox
$network.Text = 'http://127.0.0.1:18600'; $network.Location = New-Object Drawing.Point(114,198)
$network.Size = New-Object Drawing.Size(590,28); $network.ReadOnly = $true; $form.Controls.Add($network)
$mode.Add_SelectedIndexChanged({
    $network.ReadOnly = $mode.SelectedIndex -ne 2
    $session.Text = @('rec01','personal','participant','classroom')[$mode.SelectedIndex]
    if ($mode.SelectedIndex -ne 2) { $network.Text = 'http://127.0.0.1:18600' }
})
$status = LabelAt '尚未启动。五个角色均由你在网页正常创建钱包和登记。' 24 288 680 50
$status.ForeColor = [Drawing.Color]::FromArgb(30,70,110)
function Set-Locked([bool]$locked) {
    $mode.Enabled = -not $locked; $session.Enabled = -not $locked; $network.Enabled = -not $locked
    $start.Enabled = -not $locked
}
function Open-Pages {
    if (-not $script:stateFile -or -not (Test-Path -LiteralPath $script:stateFile)) { return }
    try { $state = Get-Content -LiteralPath $script:stateFile -Raw -Encoding UTF8 | ConvertFrom-Json } catch { return }
    if ($state.status -ne 'ready') { return }
    foreach ($role in @('client','p1','p2','p3','p4')) {
        if ($state.apps.$role) { Start-Process $state.apps.$role.url }
    }
}
function Start-Runtime {
    $sessionValue = $session.Text.Trim()
    $control = Join-Path $controlRoot $sessionValue
    New-Item -ItemType Directory -Path $control -Force | Out-Null
    $script:stateFile = Join-Path $control 'state.json'
    if (Test-Path -LiteralPath $script:stateFile) { Remove-Item -LiteralPath $script:stateFile }
    $python = Join-Path $AppRoot '.venv/Scripts/python.exe'
    $runtime = Join-Path $PSScriptRoot 'desktop_runtime.py'
    $arguments = @('-u', ('"' + $runtime + '"'), '--root', ('"' + $AppRoot + '"'), '--mode', $script:pendingMode,
        '--session', $sessionValue, '--network', ('"' + $network.Text.Trim() + '"'))
    $env:PYTHONUTF8 = '1'
    $script:proc = Start-Process -FilePath $python -ArgumentList $arguments -WorkingDirectory $AppRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $control 'launcher.log') -RedirectStandardError (Join-Path $control 'launcher-error.log')
    $script:phase = 'starting'; $script:autoOpened = $false
    $status.Text = '正在启动网络和用户，请稍候……'
}
function Request-Stop {
    if ($script:phase -eq 'installing') { Notify '依赖正在安装，请等待安装结束后再关闭。'; return }
    if ($script:stateFile) {
        [IO.File]::WriteAllText((Join-Path (Split-Path -Parent $script:stateFile) 'STOP'), 'stop')
        $script:phase = 'stopping'; $status.Text = '正在锁定钱包、保存网络并退出，请稍候……'
    }
}
$start = ButtonAt '启动并打开页面' 24 242 220 {
    try {
        if ($session.Text.Trim() -notmatch '^[A-Za-z0-9_-]{1,24}$') { Notify '数据组请填写 1–24 位字母、数字、横线或下划线。'; return }
        $parsed = $null
        if (-not [Uri]::TryCreate($network.Text.Trim(), [UriKind]::Absolute, [ref]$parsed) -or $parsed.Scheme -notin @('http','https') -or $network.Text.Contains('"')) { Notify '请填写有效的 http 或 https 网络地址。'; return }
        $script:pendingMode = @('classroom','solo','join','host')[$mode.SelectedIndex]
        $currentSessionState = Join-Path (Join-Path $controlRoot $session.Text.Trim()) 'state.json'
    if ($script:pendingMode -in @('classroom','solo','host') -and (Test-Path -LiteralPath $currentSessionState)) {
            $session.Text = 'rec_' + (Get-Date -Format 'yyyyMMdd_HHmmss')
        }
        $ports = if ($script:pendingMode -eq 'join') { @(18701) } elseif ($script:pendingMode -eq 'classroom') { @(18600,18701,18703,18704,18705,18706) } else { @(18600,18701) }
        $busy = @([Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners() | Where-Object { $_.Port -in $ports })
        if ($busy.Count) { Notify ('所需端口正在使用：' + (($busy | Select-Object -ExpandProperty Port -Unique) -join '、') + '。若已启动，请使用“打开用户页面”；否则关闭旧演示后重试。'); return }
        Set-Locked $true
        $python = Join-Path $AppRoot '.venv/Scripts/python.exe'
        $anvil = Join-Path $AppRoot '.tools/bin/anvil.exe'
        if (-not (Test-Path -LiteralPath $python) -or ($script:pendingMode -ne 'join' -and -not (Test-Path -LiteralPath $anvil))) {
            New-Item -ItemType Directory -Path $controlRoot -Force | Out-Null
            $role = if ($script:pendingMode -eq 'join') { 'Participant' } else { 'Host' }
            $arguments = @('-NoProfile','-ExecutionPolicy','Bypass','-File', ('"' + (Join-Path $AppRoot 'Install-DeGPU.ps1') + '"'), '-Role', $role)
            $script:installProc = Start-Process powershell.exe -ArgumentList $arguments -WorkingDirectory $AppRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $controlRoot 'install.log') -RedirectStandardError (Join-Path $controlRoot 'install-error.log')
            $script:phase = 'installing'; $status.Text = '首次安装中：正在下载 Python 和依赖。需要联网，耗时取决于网速。'
        } else { Start-Runtime }
    } catch { $status.Text = '启动未完成：' + $_.Exception.Message; $script:phase = 'error'; Set-Locked $false }
}
$open = ButtonAt '打开用户页面' 258 242 214 { Open-Pages }
$stop = ButtonAt '保存并停止' 486 242 218 { Request-Stop }
$null = LabelAt '客户 18701     P1 18703     P2 18704     P3 18705     P4 18706' 24 350 680 28
$null = LabelAt '五人演示：每页创建自己的钱包 → 加入同一网络 → 领取测试币。' 24 386 680 28
$null = LabelAt 'P1–P4 再进入“提供机器”，质押、报价并登记。客户无需登记机器。' 24 417 680 28
$null = LabelAt 'Blender 为可选项。结束前先停止报价、完成任务，再保存并停止。' 24 448 680 28
$logs = ButtonAt '查看运行日志' 24 502 180 { New-Item -ItemType Directory -Path $controlRoot -Force | Out-Null; Start-Process explorer.exe -ArgumentList ('"' + $controlRoot + '"') }
$folder = ButtonAt '打开软件目录' 218 502 180 { Start-Process explorer.exe -ArgumentList ('"' + $AppRoot + '"') }
$hint = LabelAt '关闭本窗口会保存并停止服务。旧数据保留；重新启动本机网络会新建数据组。' 24 554 690 25
$timer = New-Object Windows.Forms.Timer
$timer.Interval = 500
$timer.Add_Tick({
    try {
        if ($script:phase -eq 'installing') {
            if ($script:installProc.HasExited) {
                if ($script:installProc.ExitCode -eq 0) { Start-Runtime }
                else { $script:phase = 'error'; $status.Text = '安装未完成，请点“查看运行日志”，查看 install-error.log 后重试。'; Set-Locked $false }
            }
            return
        }
        if ($script:phase -eq 'starting' -and $script:proc -and $script:proc.HasExited -and -not (Test-Path -LiteralPath $script:stateFile)) {
            $script:phase = 'error'; $status.Text = '启动未完成，请查看 launcher.log。'; Set-Locked $false; return
        }
        if (-not $script:stateFile -or -not (Test-Path -LiteralPath $script:stateFile)) { return }
        $state = Get-Content -LiteralPath $script:stateFile -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($script:phase -eq 'starting' -and $script:proc -and $script:proc.HasExited -and $state.status -notin @('stopped','error')) {
            $script:phase = 'error'; $status.Text = '启动未完成，请查看 launcher.log。'; Set-Locked $false; return
        }
        if ($state.status -eq 'ready' -and $script:phase -ne 'stopping') {
            $script:phase = 'ready'; $status.Text = '已就绪。请在网页正常创建/解锁钱包并加入网络。'
            if (-not $script:autoOpened) { $script:autoOpened = $true; Open-Pages }
        } elseif ($state.status -in @('stopped','error')) {
            $script:phase = $state.status
            $status.Text = if ($state.status -eq 'stopped') { '已停止，钱包与网络数据已保留。可以重新启动或关闭窗口。' } else { '运行未完成：' + $state.error }
            Set-Locked $false
            if ($script:closePending) { $form.Close() }
        } elseif ($state.status -eq 'error') {
            $script:phase = 'error'; $status.Text = '启动未完成：' + $state.error; Set-Locked $false
        }
    } catch { $status.Text = '正在读取状态，请稍候……' }
})
$form.Add_FormClosing({
    param($sender,$eventArgs)
    if ($script:phase -in @('installing','starting','ready','stopping')) {
        $eventArgs.Cancel = $true
        if ($script:phase -ne 'installing') { $script:closePending = $true; Request-Stop }
        else { $status.Text = '正在安装，请等待完成后关闭。' }
    }
})
foreach ($existing in @(Read-States | Where-Object { $_.status -in @('starting','ready','stopping') })) {
    $running = Get-CimInstance Win32_Process -Filter ('ProcessId=' + [int]$existing.pid) -ErrorAction SilentlyContinue
    if ($running -and $running.CommandLine -like ('*' + (Join-Path $PSScriptRoot 'desktop_runtime.py') + '*')) {
        $script:stateFile = Join-Path $controlRoot ($existing.session + '/state.json')
        $mode.SelectedIndex = [Array]::IndexOf(@('classroom','solo','join','host'), $existing.mode)
        $session.Text = $existing.session; $network.Text = $existing.network
        $script:phase = $existing.status; $script:autoOpened = $true
        Set-Locked $true
        break
    }
}
if (-not $script:stateFile) {
    if ($mode.SelectedIndex -in @(0,1,3) -and (Test-Path -LiteralPath (Join-Path (Join-Path $controlRoot $session.Text) 'state.json'))) {
        $session.Text = 'rec_' + (Get-Date -Format 'yyyyMMdd_HHmmss')
    } elseif ($mode.SelectedIndex -eq 2) {
        $session.Text = 'participant'
    }
}
try { $timer.Start(); [void]$form.ShowDialog() }
finally { $timer.Stop(); $mutex.ReleaseMutex(); $mutex.Dispose(); $form.Dispose() }
