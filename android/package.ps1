$ErrorActionPreference = 'Stop'
$workspace = Split-Path -Parent $PSScriptRoot
$apk = Join-Path $workspace 'dist\agent-bridge.apk'
if (-not (Test-Path -LiteralPath $apk)) { throw '先运行 android\build.ps1 生成已签名 APK。' }
Add-Type -AssemblyName System.IO.Compression
$archive = Join-Path $workspace 'dist\agent-bridge-android.zip'
$stream = [System.IO.File]::Open($archive, [System.IO.FileMode]::Create)
$zip = New-Object System.IO.Compression.ZipArchive($stream, [System.IO.Compression.ZipArchiveMode]::Create)
try {
  $entries = @(
    @{ Source = $apk; Name = 'agent-bridge.apk' },
    @{ Source = (Join-Path $PSScriptRoot 'README.md'); Name = 'README.md' }
  )
  $serviceFiles = @('server.mjs','start.cmd','config.template.json','README.md','PROGRESS.md',
    'lib\config.mjs','lib\crypto.mjs','lib\push.mjs','lib\server.mjs','lib\store.mjs','lib\desktop.mjs','PHASE3.md',
    'hook.mjs','hooks.template.json','PHASE2.md','review-hooks.cmd','tools\open-codex.ps1','tools\pairing-window.ps1',
    'tools\run-tests.mjs','tools\install-autostart.ps1','tools\install.mjs','tools\inspect-hooks.mjs',
    'tests\crypto.test.mjs','tests\reliability.test.mjs','tests\server.test.mjs','tests\hook.test.mjs','tests\install.test.mjs','tests\hooks-integration.test.mjs','tests\desktop.test.mjs','tests\desktop-http.test.mjs','tests\web.test.mjs','tests\web-push.test.mjs')
  $serviceFiles += Get-ChildItem -LiteralPath (Join-Path $workspace 'public') -File | ForEach-Object { 'public\' + $_.Name }
  foreach ($file in $serviceFiles) { $entries += @{ Source = (Join-Path $workspace $file); Name = ('service/' + $file.Replace('\','/')) } }
  $sourceFiles = @('AndroidManifest.xml','build.ps1','package.ps1','README.md')
  $sourceFiles += Get-ChildItem -LiteralPath "$PSScriptRoot\src","$PSScriptRoot\res","$PSScriptRoot\tests" -Recurse -File | ForEach-Object { $_.FullName.Substring($PSScriptRoot.Length + 1) }
  foreach ($file in $sourceFiles) { $entries += @{ Source = (Join-Path $PSScriptRoot $file); Name = ('android/' + $file.Replace('\','/')) } }
  foreach ($item in $entries) {
    $entry = $zip.CreateEntry(('agent-bridge-android/' + $item.Name))
    $inputFile = [System.IO.File]::OpenRead($item.Source)
    $outputFile = $entry.Open()
    try { $inputFile.CopyTo($outputFile) } finally { $outputFile.Dispose(); $inputFile.Dispose() }
  }
  $package = $zip.CreateEntry('agent-bridge-android/service/package.json')
  $writer = New-Object System.IO.StreamWriter($package.Open())
  try { $writer.Write('{"name":"agent-bridge-service","version":"0.4.0","private":true,"type":"module","engines":{"node":">=20.11.0"},"scripts":{"start":"node server.mjs","test":"node tools/run-tests.mjs"},"dependencies":{}}') } finally { $writer.Dispose() }
} finally { $zip.Dispose(); $stream.Dispose() }
Write-Output $archive
