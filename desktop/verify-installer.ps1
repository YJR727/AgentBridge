param([string]$Setup=(Join-Path $PSScriptRoot '..\dist\AgentBridge-Setup.exe'))
$ErrorActionPreference='Stop'
$registry='HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\AgentBridge.Desktop_is1'
if(Test-Path -LiteralPath $registry){throw '已有正式安装，不在真实安装上运行隔离卸载验收。'}
$taskRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot ('..\.ui-check\installer-'+[Guid]::NewGuid().ToString('N'))))
$install=Join-Path $taskRoot 'installed app'
$env:AGENT_BRIDGE_DESKTOP_HOME=Join-Path $taskRoot 'profile'
$env:AGENT_BRIDGE_DATA=Join-Path $taskRoot 'phone data'
New-Item -ItemType Directory -Path $env:AGENT_BRIDGE_DESKTOP_HOME,$env:AGENT_BRIDGE_DATA -Force|Out-Null
$listener=New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback,0)
$listener.Start();$env:AGENT_BRIDGE_PORT=[string]$listener.LocalEndpoint.Port;$listener.Stop()
$desktopLink=Join-Path ([Environment]::GetFolderPath('Desktop')) 'Agent Bridge.lnk'
$menu=Join-Path ([Environment]::GetFolderPath('Programs')) 'Agent Bridge'
$preserveShortcuts=(Test-Path -LiteralPath $desktopLink) -or (Test-Path -LiteralPath $menu)
$shortcutHashes=@{}
if(Test-Path -LiteralPath $desktopLink){$shortcutHashes[$desktopLink]=(Get-FileHash -LiteralPath $desktopLink).Hash}
if(Test-Path -LiteralPath $menu){foreach($linkFile in Get-ChildItem -LiteralPath $menu -File -Recurse){$shortcutHashes[$linkFile.FullName]=(Get-FileHash -LiteralPath $linkFile.FullName).Hash}}
$shortcutCopies=@{}
if($shortcutHashes.Count){
    $backup=Join-Path $taskRoot 'existing shortcuts'
    New-Item -ItemType Directory -Path $backup -Force|Out-Null
    foreach($link in $shortcutHashes.Keys){$copy=Join-Path $backup ([Guid]::NewGuid().ToString('N')+'.lnk');Copy-Item -LiteralPath $link -Destination $copy;$shortcutCopies[$link]=$copy}
}
$iconOptions=if($preserveShortcuts){@('/NOICONS','/MERGETASKS=!desktopicon')}else{@('/TASKS=desktopicon')}
$setupPath=[IO.Path]::GetFullPath($Setup)
function WaitTask($process){if(-not $process.WaitForExit(45000)){throw '安装验收超时'};if($process.ExitCode -ne 0){throw ('验收子进程失败：'+$process.ExitCode)}}
$uninstaller=$null;$running=$null
try {
    WaitTask (Start-Process -FilePath $setupPath -ArgumentList (@('/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART',('/DIR="'+$install+'"'),('/LOG="'+(Join-Path $taskRoot 'install.log')+'"'))+$iconOptions) -WindowStyle Hidden -PassThru)
    $app=Join-Path $install 'AgentBridge.exe';$uninstaller=Join-Path $install 'unins000.exe'
    if(-not(Test-Path -LiteralPath $app) -or -not(Test-Path -LiteralPath $uninstaller) -or -not(Test-Path -LiteralPath $registry)){throw '安装文件或卸载注册缺失'}
    $shell=New-Object -ComObject WScript.Shell
    if(-not $preserveShortcuts){foreach($link in @($desktopLink,(Join-Path $menu 'Agent Bridge.lnk'))){if(-not(Test-Path -LiteralPath $link) -or $shell.CreateShortcut($link).TargetPath -ne $app){throw '快捷方式目标不正确'}}}
    WaitTask (Start-Process -FilePath $app -ArgumentList '--self-test' -WindowStyle Hidden -PassThru)
    $configPath=Join-Path $env:AGENT_BRIDGE_DATA 'config.json';$before=(Get-FileHash -LiteralPath $configPath).Hash
    WaitTask (Start-Process -FilePath $app -ArgumentList '--check' -WindowStyle Hidden -PassThru)
    if((Get-FileHash -LiteralPath $configPath).Hash -ne $before){throw '界面检查更改了配对配置'}
    $running=Start-Process -FilePath $app -WindowStyle Hidden -PassThru
    for($i=0;$i -lt 40;$i++){try{$health=Invoke-RestMethod ('http://127.0.0.1:'+$env:AGENT_BRIDGE_PORT+'/api/health') -TimeoutSec 1;if($health.ok){break}}catch{};Start-Sleep -Milliseconds 200}
    if(-not $health.ok){throw '安装后的应用未启动服务'}
    # Upgrade the running app through the same installer; its --quit uses the owner's private signal.
    WaitTask (Start-Process -FilePath $setupPath -ArgumentList (@('/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART',('/DIR="'+$install+'"'),('/LOG="'+(Join-Path $taskRoot 'upgrade.log')+'"'))+$iconOptions) -WindowStyle Hidden -PassThru)
    if(-not $running.WaitForExit(5000)){throw '升级没有退出旧控制器'}
    if((Get-FileHash -LiteralPath $configPath).Hash -ne $before){throw '升级改变了配对数据'}
    $running=Start-Process -FilePath $app -WindowStyle Hidden -PassThru
    Start-Sleep -Milliseconds 1800
    WaitTask (Start-Process -FilePath $uninstaller -ArgumentList @('/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART',('/LOG="'+(Join-Path $taskRoot 'uninstall.log')+'"')) -WindowStyle Hidden -PassThru)
    if(-not $running.WaitForExit(5000)){throw '卸载没有退出应用'}
    if((Test-Path -LiteralPath $app) -or ((-not $preserveShortcuts) -and (Test-Path -LiteralPath $desktopLink)) -or (Test-Path -LiteralPath $registry)){throw '卸载残留程序、快捷方式或卸载注册'}
    if((Get-FileHash -LiteralPath $configPath).Hash -ne $before){throw '卸载删除或改变了配对数据'}
    foreach($link in $shortcutHashes.Keys){if(-not(Test-Path -LiteralPath $link) -or (Get-FileHash -LiteralPath $link).Hash -ne $shortcutHashes[$link]){throw '隔离验收更改了已有快捷方式'}}
    [pscustomobject]@{Install=$true;Shortcuts=(-not $preserveShortcuts);ExistingShortcutsPreserved=$preserveShortcuts;Upgrade=$true;Uninstall=$true;UserDataPreserved=$true;ReportDirectory=$taskRoot}|ConvertTo-Json -Depth 3
}finally {
    if($running -and -not $running.HasExited -and (Test-Path -LiteralPath (Join-Path $install 'AgentBridge.exe'))){WaitTask (Start-Process -FilePath (Join-Path $install 'AgentBridge.exe') -ArgumentList '--quit' -WindowStyle Hidden -PassThru)}
    if($uninstaller -and (Test-Path -LiteralPath $uninstaller) -and (Test-Path -LiteralPath $registry)){WaitTask (Start-Process -FilePath $uninstaller -ArgumentList '/VERYSILENT /SUPPRESSMSGBOXES /NORESTART' -WindowStyle Hidden -PassThru)}
    foreach($link in $shortcutCopies.Keys){
        if(-not(Test-Path -LiteralPath $link) -or (Get-FileHash -LiteralPath $link).Hash -ne $shortcutHashes[$link]){
            New-Item -ItemType Directory -Path (Split-Path -Parent $link) -Force|Out-Null
            Copy-Item -LiteralPath $shortcutCopies[$link] -Destination $link -Force
        }
    }
}
