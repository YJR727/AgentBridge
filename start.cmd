@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found. Install Node.js 20.11 or newer, then reopen this window.
  pause
  exit /b 1
)
echo Starting Agent Bridge 0.4.0...
echo Keep the service window open. Open Codex, then select a chat on your phone.
echo.
if /I not "%~1"=="--check" start "" powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -STA -File "%~dp0tools\pairing-window.ps1"
node server.mjs %*
set "EXITCODE=%ERRORLEVEL%"
echo.
echo Service stopped. Exit code: %EXITCODE%
if /I not "%~1"=="--check" pause
exit /b %EXITCODE%
