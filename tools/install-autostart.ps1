# Agent Bridge 开机自启 / 停止（Windows 计划任务）
#
# 用法（普通窗口即可运行，脚本会在需要时自己请求提权）：
#   powershell -ExecutionPolicy Bypass -File tools\install-autostart.ps1 -Action install
#   powershell -ExecutionPolicy Bypass -File tools\install-autostart.ps1 -Action status
#   powershell -ExecutionPolicy Bypass -File tools\install-autostart.ps1 -Action uninstall
#
# 做的事情：
#   注册一个名为 "Agent Bridge" 的计划任务，在你登录时启动 node server.mjs。
#   任务只监听 127.0.0.1，对外仍然由 tailscale serve 提供 HTTPS —— 不自启任何公网入口。
#
# 为什么用"登录时触发"而不是"开机时触发"：
#   开机时用户配置文件还没加载，且 tailscale serve 也需要用户登录后才有意义。
#   登录触发对"我离开电脑但机器没关机"这个场景足够。

param(
  [ValidateSet('install', 'uninstall', 'status', 'start', 'stop')]
  [string]$Action = 'status',
  [string]$TaskName = 'Agent Bridge'
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$serverScript = Join-Path $projectRoot 'server.mjs'

function Test-Admin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Invoke-Elevated {
  param([string]$ArgLine)
  Write-Host "需要管理员权限，正在请求提权..." -ForegroundColor Yellow
  Start-Process -FilePath 'powershell.exe' -WindowStyle Hidden -Verb RunAs -ArgumentList @(
    '-NoProfile', '-ExecutionPolicy', 'Bypass',
    '-File', "`"$PSCommandPath`"",
    '-Action', $Action,
    '-TaskName', "`"$TaskName`""
  ) | Out-Null
  Write-Host "已在新窗口里继续。请在那里查看结果。" -ForegroundColor Green
}

function Get-NodePath {
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if (-not $cmd) {
    throw 'PATH 里找不到 node。请先安装 Node.js 20+。'
  }
  return $cmd.Source
}

function Show-Status {
  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if (-not $task) {
    Write-Host "计划任务 '$TaskName' 未安装。" -ForegroundColor Yellow
    Write-Host "安装：powershell -ExecutionPolicy Bypass -File tools\install-autostart.ps1 -Action install"
    return
  }
  $info = Get-ScheduledTaskInfo -TaskName $TaskName
  Write-Host "计划任务：$TaskName" -ForegroundColor Green
  Write-Host "  状态：$($task.State)"
  Write-Host "  上次运行：$($info.LastRunTime)（结果码 $($info.LastTaskResult)）"
  Write-Host "  下次运行：$($info.NextRunTime)"
  Write-Host "  动作：$(($task.Actions | ForEach-Object { "$($_.Execute) $($_.Arguments)" }) -join ' | ')"

  $listening = Get-NetTCPConnection -LocalPort 4571 -State Listen -ErrorAction SilentlyContinue
  if ($listening) {
    Write-Host "  服务：正在监听 127.0.0.1:4571（PID $($listening[0].OwningProcess)）" -ForegroundColor Green
  } else {
    Write-Host "  服务：没有在监听 4571（可能停着，或者配置里改了端口）" -ForegroundColor Yellow
  }
}

function Install-Task {
  if (-not (Test-Admin)) { return Invoke-Elevated }
  if (-not (Test-Path $serverScript)) { throw "找不到 $serverScript" }

  $node = Get-NodePath
  $action = New-ScheduledTaskAction -Execute $node -Argument "`"$serverScript`"" -WorkingDirectory $projectRoot
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
  # 不设执行时限（常驻服务）；不因电池/空闲而停止；失败后重启
  $settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -MultipleInstances IgnoreNew

  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings `
    -Description 'Agent Bridge：把 Codex 的事件推到手机的本地服务（只监听 127.0.0.1）' -Force | Out-Null

  Write-Host "已注册计划任务 '$TaskName'。" -ForegroundColor Green
  Write-Host "  启动命令：$node `"$serverScript`""
  Write-Host "  触发条件：用户 $env:USERNAME 登录时"
  Write-Host ""
  Write-Host "现在启动一次："
  Start-ScheduledTask -TaskName $TaskName
  Start-Sleep -Seconds 2
  Show-Status
}

function Uninstall-Task {
  if (-not (Test-Admin)) { return Invoke-Elevated }
  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if (-not $task) {
    Write-Host "计划任务 '$TaskName' 本来就不存在。" -ForegroundColor Yellow
    return
  }
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Write-Host "已删除计划任务 '$TaskName'。" -ForegroundColor Green
}

switch ($Action) {
  'install' { Install-Task }
  'uninstall' { Uninstall-Task }
  'start' { Start-ScheduledTask -TaskName $TaskName; Start-Sleep -Seconds 2; Show-Status }
  'stop' { Stop-ScheduledTask -TaskName $TaskName; Write-Host "已停止。" -ForegroundColor Green }
  'status' { Show-Status }
}
