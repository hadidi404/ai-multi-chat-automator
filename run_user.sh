#!/usr/bin/env bash
set -e

cd "$(dirname "$0")"

echo "AI Automation Launcher"
echo "======================"

echo "Checking dependencies..."
if [ ! -d "node_modules" ]; then
  echo "Installing Node dependencies..."
  npm install
fi

echo "Starting automation..."
node run_all.js
