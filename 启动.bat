@echo off
cd /d "%~dp0"
echo Starting GitHub Scout...
npm run electron:dev
if errorlevel 1 (
  echo.
  echo Startup failed. Press any key to close...
  pause >nul
)
