@echo off
setlocal
cd /d %~dp0

echo AI Automation Launcher
echo ======================

echo Checking dependencies...
if not exist node_modules (
  echo Installing Node dependencies...
  call npm install
)

echo Starting automation...
call node run_all.js

endlocal
