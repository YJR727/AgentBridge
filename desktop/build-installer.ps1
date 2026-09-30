param([string]$Executable=(Join-Path $PSScriptRoot '..\dist\AgentBridge.exe'),[string]$Compiler=(Join-Path $PSScriptRoot 'build-tools\Inno\ISCC.exe'))
$ErrorActionPreference='Stop'
if(-not(Test-Path -LiteralPath $Compiler)){throw '请指定 Inno Setup ISCC.exe 编译器。'}
$file=Get-Item -LiteralPath $Executable
if($file.VersionInfo.FileVersion -ne '0.2.5.0'){throw '请先生成已验证的 0.2.5 EXE。'}
$icon=(Get-ChildItem (Join-Path $PSScriptRoot 'build') -Filter 'agent-bridge.ico' -Recurse|Sort-Object LastWriteTime -Descending|Select-Object -First 1).FullName
if(-not $icon){throw '应用图标未生成。'}
$output=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\dist'))
& $Compiler ('/DAppExe='+$file.FullName) ('/DAppIcon='+$icon) ('/DOutputDirectory='+$output) (Join-Path $PSScriptRoot 'installer.iss')
if($LASTEXITCODE){throw '安装包编译失败。'}
Get-Item (Join-Path $output 'AgentBridge-Setup.exe')|Select-Object FullName,Length
