@echo off
setlocal
cd /d %~dp0

echo AI Multi-Chat - Web App
echo ======================

where node >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Node.js is not installed or not in PATH.
  echo Install Node.js LTS from https://nodejs.org and reopen this file.
  echo.
  pause
  exit /b 1
)

where npm >nul 2>&1
if errorlevel 1 (
  echo [ERROR] npm is not available in PATH.
  echo Reinstall Node.js LTS and reopen this file.
  echo.
  pause
  exit /b 1
)

echo Checking dependencies...
if not exist node_modules (
  echo Installing Node dependencies...
  call npm install
  if errorlevel 1 (
    echo.
    echo [ERROR] npm install failed.
    pause
    exit /b 1
  )
)

echo.
echo Starting the web app. Your browser will open automatically.
echo Keep this window open while you use it - closing it stops the app.
echo.
call node server.js
if errorlevel 1 (
  echo.
  echo [ERROR] The web app exited with an error.
  pause
  exit /b 1
)

endlocal
