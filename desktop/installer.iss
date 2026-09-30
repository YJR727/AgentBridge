#ifndef AppExe
  #error AppExe must point to the verified AgentBridge.exe
#endif
#ifndef OutputDirectory
  #define OutputDirectory "..\dist"
#endif
[Setup]
AppId=AgentBridge.Desktop
AppName=Agent Bridge
AppVersion=0.2.5
AppPublisher=Agent Bridge
DefaultDirName={localappdata}\Programs\Agent Bridge
DefaultGroupName=Agent Bridge
DisableProgramGroupPage=yes
AllowNoIcons=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0.17763
WizardStyle=modern
WizardSizePercent=110
SetupIconFile={#AppIcon}
UninstallDisplayIcon={app}\AgentBridge.exe
OutputDir={#OutputDirectory}
OutputBaseFilename=AgentBridge-Setup
Compression=lzma2
SolidCompression=yes
CloseApplications=yes
CloseApplicationsFilter=AgentBridge.exe
RestartApplications=no
SetupLogging=yes
DisableWelcomePage=no
[Languages]
Name: "chinesesimplified"; MessagesFile: "compiler:Languages\ChineseSimplified.isl"
[Tasks]
Name: "desktopicon"; Description: "创建桌面快捷方式"; GroupDescription: "快捷方式："
[Files]
Source: "{#AppExe}"; DestDir: "{app}"; DestName: "AgentBridge.exe"; Flags: ignoreversion
[Icons]
Name: "{userdesktop}\Agent Bridge"; Filename: "{app}\AgentBridge.exe"; Tasks: desktopicon; Check: not WizardNoIcons
Name: "{userprograms}\Agent Bridge\Agent Bridge"; Filename: "{app}\AgentBridge.exe"; Check: not WizardNoIcons
Name: "{userprograms}\Agent Bridge\卸载 Agent Bridge"; Filename: "{uninstallexe}"; Check: not WizardNoIcons
[Run]
Filename: "{app}\AgentBridge.exe"; Description: "启动 Agent Bridge"; Flags: nowait postinstall skipifsilent
[UninstallRun]
Filename: "{app}\AgentBridge.exe"; Parameters: "--quit"; Flags: runhidden waituntilterminated; RunOnceId: "StopAgentBridge"
[Code]
function InitializeSetup(): Boolean;
var Release: Cardinal;
begin
  Result := RegQueryDWordValue(HKLM, 'SOFTWARE\Microsoft\NET Framework Setup\NDP\v4\Full', 'Release', Release) and (Release >= 528040);
  if not Result then MsgBox('请先安装 Microsoft .NET Framework 4.8，再安装 Agent Bridge。', mbError, MB_OK);
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
var ResultCode: Integer; Version: String;
begin
  Result := '';
  if FileExists(ExpandConstant('{app}\AgentBridge.exe')) and GetVersionNumbersString(ExpandConstant('{app}\AgentBridge.exe'), Version) and (CompareStr(Version, '0.2.0.0') >= 0) then
  begin
    Exec(ExpandConstant('{app}\AgentBridge.exe'), '--quit', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
    if ResultCode <> 0 then begin
      Result := '请先从系统托盘退出 Agent Bridge，再继续安装。';
      Exit;
    end;
    Sleep(1500);
  end;
end;
