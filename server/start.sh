#!/bin/bash
# OTPZ iMessage Bridge Server — Quick Start
# Usage: ./start.sh

cd "$(dirname "$0")"

# Check Node.js version
if ! command -v node &> /dev/null; then
  echo "❌ Node.js is not installed. Install it from https://nodejs.org/"
  exit 1
fi

NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
  echo "❌ Node.js 18+ is required. Current: $(node -v)"
  exit 1
fi

# Install dependencies if needed
if [ ! -d "node_modules" ]; then
  echo "📦 Installing dependencies..."
  npm install
fi

echo ""
echo "🚀 Starting OTPZ iMessage Bridge..."
echo ""

node server.js
