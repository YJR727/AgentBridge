param([switch]$CheckOnly)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[Windows.Forms.Application]::EnableVisualStyles()
$workspace=Split-Path -Parent $PSScriptRoot
$pairingData=if($env:AGENT_BRIDGE_DATA){$env:AGENT_BRIDGE_DATA}else{Join-Path $workspace 'data'}
$configPath=Join-Path $pairingData 'config.json'
$form=New-Object Windows.Forms.Form
$form.Text='Agent Bridge · 电脑配对'
$form.ClientSize=New-Object Drawing.Size(540,300)
$form.StartPosition='CenterScreen'
$form.FormBorderStyle='FixedDialog'
$form.MaximizeBox=$false
$form.Font=New-Object Drawing.Font('Microsoft YaHei UI',11)
$form.BackColor=[Drawing.Color]::White
$title=New-Object Windows.Forms.Label
$title.Text='手机重新配对'
$title.Font=New-Object Drawing.Font('Microsoft YaHei UI',18,[Drawing.FontStyle]::Bold)
$title.SetBounds(24,20,490,40)
$form.Controls.Add($title)
$status=New-Object Windows.Forms.Label
$status.Text='正在等待电脑服务启动…'
$status.SetBounds(24,69,492,32)
$form.Controls.Add($status)
$codeLabel=New-Object Windows.Forms.Label
$codeLabel.Text='—'
$codeLabel.TextAlign='MiddleCenter'
$codeLabel.Font=New-Object Drawing.Font('Consolas',28,[Drawing.FontStyle]::Bold)
$codeLabel.ForeColor=[Drawing.Color]::FromArgb(15,118,110)
$codeLabel.SetBounds(24,108,492,60)
$form.Controls.Add($codeLabel)
$resetButton=New-Object Windows.Forms.Button
$resetButton.Text='重新配对，生成新码'
$resetButton.SetBounds(24,183,492,48)
$resetButton.Enabled=$false
$form.Controls.Add($resetButton)
$note=New-Object Windows.Forms.Label
$note.Text='点击会撤销旧手机配对和待处理审批。新码五分钟内有效。'
$note.SetBounds(24,244,492,46)
$form.Controls.Add($note)
function PairingRequest([string]$method,[string]$path) {
  if(-not(Test-Path -LiteralPath $configPath)){throw '服务未启动'}
  $config=[IO.File]::ReadAllText($configPath)|ConvertFrom-Json
  $pairingPort=if($env:AGENT_BRIDGE_PORT){[int]$env:AGENT_BRIDGE_PORT}else{[int]$config.port}
  $request=@{Uri="http://127.0.0.1:$pairingPort$path";Method=$method;Headers=@{Authorization=('Bearer '+$config.hookToken)};TimeoutSec=3}
  if($method -eq 'POST'){$request.Body='{}';$request.ContentType='application/json'}
  Invoke-RestMethod @request
}
function UpdatePairing($state) {
  $resetButton.Enabled=$true
  if($state.paired){$codeLabel.Text='已配对';$status.Text='电脑保存了旧配对。需要新码时请点击下面按钮。'}
  elseif($state.code){
    $codeLabel.Text=$state.code
    $remaining=[Math]::Max(0,[int](($state.expiresAt-[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())/1000))
    $status.Text="请在手机输入此码，剩余 $remaining 秒。"
  }else{$codeLabel.Text='已过期';$status.Text='配对码已过期，请点击下面按钮生成新码。'}
}
$timer=New-Object Windows.Forms.Timer
$timer.Interval=2000
$timer.Add_Tick({
  try{UpdatePairing (PairingRequest 'GET' '/api/local/pairing')}
  catch{$resetButton.Enabled=$false;$codeLabel.Text='—';$status.Text='服务不可用，请保持 start.cmd 窗口运行或重新启动服务。'}
})
$resetButton.Add_Click({
  $timer.Stop();$resetButton.Enabled=$false
  try{UpdatePairing (PairingRequest 'POST' '/api/local/pairing/reset')}
  catch{[Windows.Forms.MessageBox]::Show('生成失败，请确认已重启更新后的电脑服务。','重新配对')|Out-Null}
  finally{$timer.Start()}
})
if($CheckOnly){
  $resetButton.Enabled=$true
  $status.Text='配对控制窗自检；未连接服务、未重置真实配对。'
  $codeLabel.Text='示例配对码'
  $form.Show()
  [Windows.Forms.Application]::DoEvents()
  $bitmap=New-Object Drawing.Bitmap($form.Width,$form.Height)
  try{$form.DrawToBitmap($bitmap,(New-Object Drawing.Rectangle(0,0,$form.Width,$form.Height)));$bitmap.Save((Join-Path $workspace 'android\pairing-window-preview.png'),[Drawing.Imaging.ImageFormat]::Png)}
  finally{$bitmap.Dispose();$timer.Dispose();$form.Dispose()}
  Write-Output 'Pairing window controls created; no pairing was changed.'
  exit 0
}
$timer.Start()
try{[void]$form.ShowDialog()}finally{$timer.Stop();$timer.Dispose();$form.Dispose()}