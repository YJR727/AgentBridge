$ErrorActionPreference = 'Stop'
$workspace = Split-Path -Parent $PSScriptRoot
$release = Join-Path $workspace 'dist\agent-bridge'
$service = Join-Path $release 'service'
New-Item -ItemType Directory -Force -Path $service | Out-Null
Copy-Item -LiteralPath (Join-Path $workspace 'plugin\agent-bridge\plugin.json') -Destination $release
Copy-Item -LiteralPath (Join-Path $workspace 'plugin\agent-bridge\skills') -Destination $release -Recurse -Force
# 明确白名单：不复制 data、真实配置、旧 hooks、notify 或 App Server。
$files = @('server.mjs','start.cmd','config.template.json','README.md','PROGRESS.md',
  'lib\config.mjs','lib\crypto.mjs','lib\push.mjs','lib\server.mjs','lib\store.mjs',
  'tools\run-tests.mjs','tools\install-autostart.ps1',
  'tests\crypto.test.mjs','tests\reliability.test.mjs','tests\server.test.mjs')
foreach ($file in $files) {
  $destination = Join-Path $service $file
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $destination) | Out-Null
  Copy-Item -LiteralPath (Join-Path $workspace $file) -Destination $destination -Force
}
Copy-Item -LiteralPath (Join-Path $workspace 'public') -Destination $service -Recurse -Force
@'
{"name":"agent-bridge-service","version":"0.1.0","private":true,"type":"module","engines":{"node":">=20.11.0"},"scripts":{"start":"node server.mjs","test":"node tools/run-tests.mjs","reset-pairing":"node server.mjs --reset-pairing"},"dependencies":{},"devDependencies":{}}
'@ | Set-Content -LiteralPath (Join-Path $service 'package.json') -Encoding utf8
$archive = Join-Path $workspace 'dist\agent-bridge.zip'
Add-Type -AssemblyName System.IO.Compression
$stream = [System.IO.File]::Open($archive, [System.IO.FileMode]::Create)
$zip = New-Object System.IO.Compression.ZipArchive($stream, [System.IO.Compression.ZipArchiveMode]::Create)
try {
  $packageFiles = @('plugin.json','skills\agent-bridge\SKILL.md','service\package.json')
  $packageFiles += $files | ForEach-Object { 'service\' + $_ }
  $packageFiles += Get-ChildItem -LiteralPath (Join-Path $workspace 'public') -File | ForEach-Object { 'service\public\' + $_.Name }
  foreach ($file in $packageFiles) {
    $entry = $zip.CreateEntry(('agent-bridge/' + $file.Replace('\','/')))
    $inputFile = [System.IO.File]::OpenRead((Join-Path $release $file))
    $outputFile = $entry.Open()
    try { $inputFile.CopyTo($outputFile) } finally { $outputFile.Dispose(); $inputFile.Dispose() }
  }
} finally { $zip.Dispose(); $stream.Dispose() }
Write-Output $archive
