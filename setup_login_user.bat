@echo off
setlocal
cd /d %~dp0

echo AI Login Setup
echo ==============

echo Checking dependencies...
if not exist node_modules (
  echo Installing Node dependencies...
  call npm install
)

echo Opening login setup...
call node setup_login.js

endlocal
