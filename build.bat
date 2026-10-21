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
  echo Usage:
  echo   build.bat --video="F:\path\video.mp4" --stage=YW-1
  echo.
  echo Optional:
  echo   --out=out\name.json    output path ^(default out\STAGE.json^)
  echo   --maa="MAA dir"        MAA install dir
  echo   --speed=1              do not switch to 2x
  exit /b 2
)
"%ELECTRON%" bin\build2.cjs %*
