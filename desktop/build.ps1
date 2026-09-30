param([string]$NodePath = '',[string]$OutputPath = '')
$ErrorActionPreference = 'Stop'
$workspace = Split-Path -Parent $PSScriptRoot
if (-not $NodePath) { $NodePath = (Get-Command node.exe -ErrorAction Stop).Source }
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $compiler)) { throw '需要 Windows .NET Framework 4.5 或以上。' }
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.Drawing
$buildRoot = Join-Path $PSScriptRoot ('build\' + [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Path $buildRoot -Force | Out-Null
# Reuse the product logo, with real sizes for Explorer, the taskbar and the tray.
$iconPath=Join-Path $buildRoot 'agent-bridge.ico'
$logo=[Drawing.Image]::FromFile((Join-Path $workspace 'public/icon-512.png'))
$images=@()
try{
    foreach($size in @(16,24,32,48,64,128,256)){
        $bitmap=New-Object Drawing.Bitmap($size,$size)
        $graphics=[Drawing.Graphics]::FromImage($bitmap)
        $graphics.InterpolationMode='HighQualityBicubic'
        $png=New-Object IO.MemoryStream
        try{$graphics.DrawImage($logo,0,0,$size,$size);$bitmap.Save($png,[Drawing.Imaging.ImageFormat]::Png);$images+=,@{size=$size;bytes=$png.ToArray()}}
        finally{$graphics.Dispose();$bitmap.Dispose();$png.Dispose()}
    }
}finally{$logo.Dispose()}
$iconWriter=New-Object IO.BinaryWriter([IO.File]::Create($iconPath))
try{
    $iconWriter.Write([UInt16]0);$iconWriter.Write([UInt16]1);$iconWriter.Write([UInt16]$images.Count)
    $offset=6+16*$images.Count
    foreach($image in $images){
        $dimension=if($image.size -eq 256){0}else{$image.size}
        $iconWriter.Write([byte]$dimension);$iconWriter.Write([byte]$dimension);$iconWriter.Write([byte]0);$iconWriter.Write([byte]0)
        $iconWriter.Write([UInt16]1);$iconWriter.Write([UInt16]32);$iconWriter.Write([UInt32]$image.bytes.Length);$iconWriter.Write([UInt32]$offset)
        $offset+=$image.bytes.Length
    }
    foreach($image in $images){$iconWriter.Write([byte[]]$image.bytes)}
}finally{$iconWriter.Dispose()}
$payloadPath = Join-Path $buildRoot 'bridge.zip'
$stream = [IO.File]::Open($payloadPath, [IO.FileMode]::Create)
$archive = New-Object IO.Compression.ZipArchive($stream, [IO.Compression.ZipArchiveMode]::Create)
try {
    $iconInput=[IO.File]::OpenRead($iconPath);$iconOutput=$archive.CreateEntry('agent-bridge.ico').Open()
    try{$iconInput.CopyTo($iconOutput)}finally{$iconInput.Dispose();$iconOutput.Dispose()}
    $files = @('server.mjs','hook.mjs','lib/config.mjs','lib/crypto.mjs','lib/push.mjs','lib/server.mjs','lib/store.mjs','lib/desktop.mjs','lib/desktop-endpoints.mjs','lib/desktop-sessions.mjs','desktop/worker.mjs')
    $files += Get-ChildItem -LiteralPath (Join-Path $workspace 'public') -File | ForEach-Object { 'public/' + $_.Name }
    foreach ($file in $files) {
        $entry = $archive.CreateEntry('app/' + $file)
        $input = [IO.File]::OpenRead((Join-Path $workspace $file)); $output = $entry.Open()
        try { $input.CopyTo($output) } finally { $input.Dispose(); $output.Dispose() }
    }
    $input = [IO.File]::OpenRead($NodePath); $output = $archive.CreateEntry('node.exe').Open()
    try { $input.CopyTo($output) } finally { $input.Dispose(); $output.Dispose() }
    $writer = New-Object IO.StreamWriter($archive.CreateEntry('legacy-root.txt').Open())
    try { $writer.Write($workspace) } finally { $writer.Dispose() }
    $nodeVersion = & $NodePath --version
    if ($LASTEXITCODE -or $nodeVersion -notmatch '^v\d+\.\d+\.\d+$') { throw 'Node 版本读取失败。' }
    $licensePath = Join-Path $PSScriptRoot ('licenses/node-' + $nodeVersion + '.txt')
    if (-not (Test-Path -LiteralPath $licensePath)) { throw '缺少对应 Node 版本的官方许可证，请从该版本的 Node.js 仓库获取 LICENSE。' }
    $license = [IO.File]::ReadAllText($licensePath)
    $writer = New-Object IO.StreamWriter($archive.CreateEntry('node-LICENSE.txt').Open())
    try { $writer.Write($license) } finally { $writer.Dispose() }
} finally { $archive.Dispose(); $stream.Dispose() }
New-Item -ItemType Directory -Path (Join-Path $workspace 'dist') -Force | Out-Null
$executable=if($OutputPath){[IO.Path]::GetFullPath($OutputPath)}else{Join-Path $workspace 'dist\AgentBridge.exe'}
New-Item -ItemType Directory -Path (Split-Path -Parent $executable) -Force|Out-Null
$wpf=Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\WPF'
& $compiler /nologo /target:winexe /platform:x64 /optimize+ "/out:$executable" "/win32icon:$iconPath" "/win32manifest:$PSScriptRoot\app.manifest" /reference:System.Windows.Forms.dll /reference:System.Drawing.dll /reference:System.Web.Extensions.dll /reference:System.IO.Compression.dll /reference:System.IO.Compression.FileSystem.dll "/reference:$wpf\WindowsBase.dll" "/reference:$wpf\PresentationCore.dll" "/reference:$wpf\PresentationFramework.dll" /reference:System.Xaml.dll "/resource:$payloadPath,bridge.zip" "/resource:$PSScriptRoot\Window.xaml,Window.xaml" (Join-Path $PSScriptRoot 'Launcher.cs') (Join-Path $PSScriptRoot 'BridgeController.cs') (Join-Path $PSScriptRoot 'BridgeWindow.cs') (Join-Path $PSScriptRoot 'DesktopChecks.cs')
if ($LASTEXITCODE) { throw '电脑控制台编译失败。' }
Write-Output $executable
