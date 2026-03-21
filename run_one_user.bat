@echo off
setlocal
cd /d %~dp0

set BOT=%~1
if "%BOT%"=="" (
  echo [ERROR] Missing bot name.
  echo Usage: run_one_user.bat chatgpt^|gemini^|perplexity^|grok^|meta
  echo.
  pause
  exit /b 1
)

echo AI Automation Launcher (Single Bot)
echo ==================================
echo Bot: %BOT%

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

if not exist questions.txt (
  echo.
  echo [ERROR] questions.txt not found.
  echo Create questions.txt in this folder, one question per line.
  echo.
  pause
  exit /b 1
)

echo Starting single-bot automation...
call node run_one.js %BOT%
if errorlevel 1 (
  echo.
  echo [ERROR] Automation exited with an error.
  pause
  exit /b 1
)

endlocal
