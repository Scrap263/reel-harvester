@echo off
setlocal
cd /d "%~dp0"
title Reel Harvester - first-time setup

where node >nul 2>&1
if errorlevel 1 (
  echo Node.js 22 or newer is required.
  echo Install it from https://nodejs.org/ and run this file again.
  pause
  exit /b 1
)

where python >nul 2>&1
if errorlevel 1 (
  echo Python 3 is required for transcription.
  echo Install it from https://www.python.org/ and run this file again.
  pause
  exit /b 1
)

echo Installing Node.js dependencies...
call npm.cmd install
if errorlevel 1 goto :failed

if not exist ".venv\Scripts\python.exe" (
  echo Creating Python environment...
  python -m venv .venv
  if errorlevel 1 goto :failed
)

echo Installing transcription dependencies...
".venv\Scripts\python.exe" -m pip install -r requirements-transcribe.txt
if errorlevel 1 goto :failed

echo.
echo Setup complete.
echo Start the app with START_REEL_HARVESTER.bat.
echo On a new computer, sign in to Instagram once when the browser opens.
pause
exit /b 0

:failed
echo.
echo Setup failed. Review the messages above and try again.
pause
exit /b 1
