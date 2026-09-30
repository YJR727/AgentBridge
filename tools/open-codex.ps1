param([switch]$CheckOnly)
$ErrorActionPreference = 'Stop'
$workspace = Split-Path -Parent $PSScriptRoot
$bundleRoot = Join-Path $env:LOCALAPPDATA 'OpenAI\Codex\bin'
$candidates = @()
if (Test-Path -LiteralPath $bundleRoot) {
  $candidates = @(Get-ChildItem -LiteralPath $bundleRoot -Directory | ForEach-Object {
    $candidatePath = Join-Path $_.FullName 'codex.exe'
    if (Test-Path -LiteralPath $candidatePath) { Get-Item -LiteralPath $candidatePath }
  } | Sort-Object LastWriteTime -Descending)
}
if ($candidates.Count) { $binaryPath = $candidates[0].FullName }
else {
  $command = Get-Command codex.exe -ErrorAction SilentlyContinue
  if (-not $command) { throw '未找到 Codex CLI，请先安装或打开 Codex 桌面应用。' }
  $binaryPath = $command.Source
}
Write-Output "Codex 路径：$binaryPath"
if ($CheckOnly) {
  & $binaryPath --version
  if ($LASTEXITCODE) { throw 'Codex CLI 自检失败' }
  exit 0
}
Write-Output '进入后输入 /hooks，审核并信任当前项目的四项 Agent Bridge 定义。'
Write-Output '不需要发送任务；不要使用绕过信任的参数。'
& $binaryPath -C $workspace
exit $LASTEXITCODE