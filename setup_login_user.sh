#!/usr/bin/env bash
set -e

cd "$(dirname "$0")"

echo "AI Login Setup"
echo "=============="

echo "Checking dependencies..."
if [ ! -d "node_modules" ]; then
  echo "Installing Node dependencies..."
  npm install
fi

echo "Opening login setup..."
node setup_login.js
