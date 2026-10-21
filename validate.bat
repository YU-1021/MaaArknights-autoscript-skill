@echo off
setlocal
set "ELECTRON_RUN_AS_NODE=1"
set "ELECTRON=F:\dspet\deepseek-fish-pet\app\node_modules\electron\dist\electron.exe"
cd /d "%~dp0"
if not exist ".tmp" mkdir ".tmp"
set "TEMP=%~dp0.tmp"
set "TMP=%~dp0.tmp"
if not exist "%ELECTRON%" (
  echo [ERROR] electron.exe not found: %ELECTRON%
  echo Edit this .bat and set ELECTRON to your electron.exe path.
  exit /b 2
)

if "%~1"=="" (
  echo Usage: validate.bat ^<copilot.json^> [--maa="MAA dir"] [--stage=YW-1]
  exit /b 2
)
"%ELECTRON%" bin\validate.cjs %*
