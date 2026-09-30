param([string]$Executable = (Join-Path $PSScriptRoot '..\dist\AgentBridge.exe'))
$ErrorActionPreference='Stop'
$taskRoot=Join-Path $PSScriptRoot ('..\.ui-check\wpf-'+[Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $taskRoot -Force|Out-Null
$env:AGENT_BRIDGE_DESKTOP_HOME=[IO.Path]::GetFullPath($taskRoot)
$process=Start-Process -FilePath ([IO.Path]::GetFullPath($Executable)) -ArgumentList '--check' -WindowStyle Hidden -PassThru
if(-not $process.WaitForExit(30000)){$process.Kill();throw '窗口验收超时'}
if($process.ExitCode -ne 0){throw "窗口验收失败，查看 $taskRoot\diagnostic.log"}
$report=Join-Path $taskRoot 'window-check.json'
if(-not(Test-Path -LiteralPath $report)){throw '缺少原生 WPF 验收报告：目前仍是 PowerShell 窗口'}
$window=Get-Content -LiteralPath $report -Raw|ConvertFrom-Json
if($window.ui -ne 'WPF' -or -not $window.singleInstance -or -not $window.trayRestore){throw '窗口或单实例验收失败'}
$env:AGENT_BRIDGE_DATA=Join-Path $taskRoot 'data'
$listener=New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback,0)
$listener.Start();$env:AGENT_BRIDGE_PORT=[string]$listener.LocalEndpoint.Port;$listener.Stop()
$process=Start-Process -FilePath ([IO.Path]::GetFullPath($Executable)) -ArgumentList '--self-test' -WindowStyle Hidden -PassThru
if(-not $process.WaitForExit(45000)){$process.Kill();throw '服务验收超时'}
if($process.ExitCode -ne 0){throw "服务验收失败，查看 $taskRoot\diagnostic.log"}
$service=Get-Content (Join-Path $taskRoot 'self-test.json') -Raw|ConvertFrom-Json
if($service.passed -lt 8){throw '缺少必要服务验收'}
[pscustomobject]@{Passed=$service.passed;UI=$window.ui;Screenshots=$window.scales;ReportDirectory=$taskRoot}|ConvertTo-Json -Depth 4
