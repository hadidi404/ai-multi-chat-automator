@echo off
setlocal
cd /d %~dp0

echo Brave Profile Launcher
echo ======================

echo Checking dependencies...
if not exist node_modules (
  echo Installing Node dependencies...
  call npm install
)

echo Opening Brave with shared profile for manual Google login...
call node open_brave_profile.js

endlocal
