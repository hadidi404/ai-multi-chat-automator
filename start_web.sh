#!/usr/bin/env bash
set -e

cd "$(dirname "$0")"

echo "AI Multi-Chat - Web App"
echo "======================"

echo "Checking dependencies..."
if [ ! -d "node_modules" ]; then
  echo "Installing Node dependencies..."
  npm install
fi

echo ""
echo "Starting the web app. Your browser will open automatically."
echo "Keep this window open while you use it - closing it stops the app."
echo ""
node server.js
