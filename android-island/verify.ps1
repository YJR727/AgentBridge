$ErrorActionPreference = 'Stop'
$workspace = Split-Path -Parent $PSScriptRoot
$protected = Get-Content -LiteralPath (Join-Path $workspace '.ui-check/island/original-hashes.json') -Raw | ConvertFrom-Json
foreach ($file in $protected) {
    if (-not (Test-Path -LiteralPath $file.Path) -or (Get-FileHash -LiteralPath $file.Path).Hash -ne $file.Hash) { throw ('Original changed: ' + $file.Path) }
}
$apk = Join-Path $workspace 'dist/agent-bridge-island-test-0.4.2-1.apk'
$tools = (Get-ChildItem -LiteralPath (Join-Path $workspace '.android-tools/build-tools') -Directory | Select-Object -First 1).FullName
$jdk = (Get-ChildItem -LiteralPath (Join-Path $workspace '.android-tools/jdk') -Directory | Select-Object -First 1).FullName
$signer = & "$jdk/bin/java.exe" -jar "$tools/lib/apksigner.jar" verify --verbose --print-certs $apk
if ($LASTEXITCODE) { throw 'APK signature verification failed' }
$oldSigner = & "$jdk/bin/java.exe" -jar "$tools/lib/apksigner.jar" verify --print-certs (Join-Path $workspace 'dist/agent-bridge-0.4.2.apk')
if ($LASTEXITCODE) { throw 'Original signature verification failed' }
$newCertificate = ($signer | Select-String 'certificate SHA-256 digest:').Line
$oldCertificate = ($oldSigner | Select-String 'certificate SHA-256 digest:').Line
if (-not $newCertificate -or $newCertificate -ne $oldCertificate) { throw 'Signing certificate mismatch' }
& "$tools/zipalign.exe" -c 4 $apk
if ($LASTEXITCODE) { throw 'APK alignment failed' }
$badging = & "$tools/aapt.exe" dump badging $apk
if ($LASTEXITCODE) { throw 'APK manifest verification failed' }
$package = ($badging | Select-String '^package:').Line
$label = ($badging | Select-String '^application-label:').Line
if ($package -notmatch "name='dev.agentbridge.island' versionCode='1' versionName='0.4.2-island.1'") { throw 'APK package identity incorrect' }
if ($label -notmatch 'Agent Bridge') { throw 'APK label missing' }
$manifest = & "$tools/aapt.exe" dump xmltree $apk AndroidManifest.xml
if ($LASTEXITCODE) { throw 'APK manifest detail unavailable' }
if ($manifest -match 'com.xiaomi.xms.APP_ID') { throw 'Unexpected platform App ID' }
$buildLog = Get-Content -LiteralPath (Join-Path $workspace '.ui-check/island/build.txt') -Raw
foreach ($expected in @('URL policy: 10 checks passed','Markdown: 16 checks passed','ChatStatus checks passed','IslandPolicy: 21 checks passed')) {
    if (-not $buildLog.Contains($expected)) { throw 'Build self-test evidence missing' }
}
$report = [ordered]@{
    verifiedAt=(Get-Date).ToString('o');package='dev.agentbridge.island';version='0.4.2-island.1';bytes=(Get-Item -LiteralPath $apk).Length
    sha256=(Get-FileHash -LiteralPath $apk).Hash;signatureValid=$true;originalCertificate=$true;alignmentValid=$true
    originalProtectedFiles=$protected.Count;originalFilesUnchanged=$true;separateAppData=$true
    platformAppIdConfigured=$false;islandDisplayVerifiedOnDevice=$false;ordinaryNotificationFallback=$true
    selfTests=@('URL policy','Markdown','ChatStatus','IslandPolicy: 21')
    scope='Independent compatibility test only; official authorization and Redmi K80 Pro device display remain unverified'
}
$json = $report | ConvertTo-Json -Depth 4
[IO.File]::WriteAllText((Join-Path $workspace 'dist/agent-bridge-island-test-0.4.2-1-verification.json'),$json,[Text.UTF8Encoding]::new($false))
$json
