param([string]$JdkPath = '', [string]$BuildToolsPath = '', [string]$PlatformJar = '')
$ErrorActionPreference = 'Stop'
$workspace = Split-Path -Parent $PSScriptRoot
$toolRoot = Join-Path $workspace '.android-tools'
if (-not $JdkPath) {
  $JdkPath = Get-ChildItem -LiteralPath (Join-Path $toolRoot 'jdk') -Directory | Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'bin\javac.exe') } | Select-Object -First 1 -ExpandProperty FullName
}
if (-not $BuildToolsPath) {
  $BuildToolsPath = Get-ChildItem -LiteralPath (Join-Path $toolRoot 'build-tools') -Directory | Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'aapt2.exe') } | Select-Object -First 1 -ExpandProperty FullName
}
if (-not $PlatformJar) { $PlatformJar = Join-Path $toolRoot 'platform\android-36\android.jar' }
if (-not $JdkPath -or -not $BuildToolsPath -or -not (Test-Path -LiteralPath $PlatformJar)) { throw '需要 JDK、Android Build Tools 36 和 API 36，支持传入其路径。' }
$java = Join-Path $JdkPath 'bin\java.exe'
$javac = Join-Path $JdkPath 'bin\javac.exe'
$jar = Join-Path $JdkPath 'bin\jar.exe'
$aapt = Join-Path $BuildToolsPath 'aapt2.exe'
$build = Join-Path $PSScriptRoot ('build\' + [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss'))
foreach ($folder in @($build, "$build\classes", "$build\generated", "$build\dex", "$build\checks", "$workspace\dist")) { New-Item -ItemType Directory -Force -Path $folder | Out-Null }

& $javac -encoding UTF-8 -d "$build\checks" "$PSScriptRoot\src\dev\agentbridge\phone\UrlPolicy.java" "$PSScriptRoot\tests\UrlPolicyTest.java" "$PSScriptRoot\src\dev\agentbridge\phone\Markdown.java" "$PSScriptRoot\tests\MarkdownTest.java"
if ($LASTEXITCODE) { throw 'Java 自测编译失败' }
& $java -cp "$build\checks" UrlPolicyTest
if ($LASTEXITCODE) { throw 'Java URL 策略自测失败' }
& $java -cp "$build\checks" MarkdownTest
if ($LASTEXITCODE) { throw 'Java Markdown 排版自测失败' }
& $javac -encoding UTF-8 -d "$build\checks" "$PSScriptRoot\src\dev\agentbridge\phone\ChatStatus.java" "$PSScriptRoot\tests\ChatStatusTest.java"
if ($LASTEXITCODE) { throw '聊天状态自测编译失败' }
& $java -cp "$build\checks" ChatStatusTest
if ($LASTEXITCODE) { throw '聊天状态自测失败' }
& $aapt compile --dir "$PSScriptRoot\res" -o "$build\resources.zip"
if ($LASTEXITCODE) { throw '资源编译失败' }
& $aapt link -I $PlatformJar --manifest "$PSScriptRoot\AndroidManifest.xml" --java "$build\generated" --min-sdk-version 26 --target-sdk-version 36 -o "$build\unsigned.apk" -R "$build\resources.zip" --auto-add-overlay
if ($LASTEXITCODE) { throw 'APK 资源打包失败' }
$sources = @(Get-ChildItem -LiteralPath "$PSScriptRoot\src","$build\generated" -Recurse -Filter '*.java' | Select-Object -ExpandProperty FullName)
& $javac -encoding UTF-8 -source 8 -target 8 -classpath $PlatformJar -d "$build\classes" @sources
if ($LASTEXITCODE) { throw '安卓源码编译失败' }
$classes = @(Get-ChildItem -LiteralPath "$build\classes" -Recurse -Filter '*.class' | Select-Object -ExpandProperty FullName)
& $java -cp "$BuildToolsPath\lib\d8.jar" com.android.tools.r8.D8 --release --min-api 26 --lib $PlatformJar --output "$build\dex" @classes
if ($LASTEXITCODE) { throw 'DEX 编译失败' }
& $jar uf "$build\unsigned.apk" -C "$build\dex" classes.dex
if ($LASTEXITCODE) { throw 'DEX 打包失败' }
& "$BuildToolsPath\zipalign.exe" -f -p 4 "$build\unsigned.apk" "$build\aligned.apk"
if ($LASTEXITCODE) { throw 'APK 对齐失败' }

# 本机私有签名密钥用于后续覆盖更新；不放入 APK 或交付源码。
$signing = Join-Path $toolRoot 'signing'
New-Item -ItemType Directory -Force -Path $signing | Out-Null
$key = Join-Path $signing 'agent-bridge.p12'
$password = Join-Path $signing 'password.txt'
if (-not (Test-Path -LiteralPath $key)) {
  $bytes = New-Object byte[] 32
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
  [System.IO.File]::WriteAllText($password, ([BitConverter]::ToString($bytes).Replace('-','')), (New-Object System.Text.UTF8Encoding($false)))
  & "$JdkPath\bin\keytool.exe" -genkeypair -alias agent-bridge -keystore $key -storetype PKCS12 -storepass:file $password -keypass:file $password -keyalg RSA -keysize 3072 -validity 10000 -dname 'CN=Agent Bridge, O=Agent Bridge'
  if ($LASTEXITCODE) { throw '签名密钥生成失败' }
}
if (-not (Test-Path -LiteralPath $password)) { throw '签名密码文件缺失，请恢复原密钥和密码，不要生成不兼容的新签名。' }
$apk = Join-Path $workspace 'dist\agent-bridge.apk'
& $java -jar "$BuildToolsPath\lib\apksigner.jar" sign --ks $key --ks-key-alias agent-bridge --ks-pass "file:$password" --out $apk "$build\aligned.apk"
if ($LASTEXITCODE) { throw 'APK 签名失败' }
& $java -jar "$BuildToolsPath\lib\apksigner.jar" verify --verbose --print-certs $apk
if ($LASTEXITCODE) { throw 'APK 签名验证失败' }
& "$BuildToolsPath\zipalign.exe" -c -v 4 $apk
if ($LASTEXITCODE) { throw 'APK 对齐验证失败' }
& "$BuildToolsPath\aapt.exe" dump badging $apk
if ($LASTEXITCODE) { throw 'APK 清单检查失败' }
Write-Output "APK ready: $apk"
