#!/bin/bash
# PAROL6 / custom-arm Startup Script
# Kills any existing PM2 processes and starts fresh

set -e

# Resolve to this script's own directory so it works regardless of where
# the repo is checked out (previously hardcoded to one developer's machine).
cd "$(dirname "$0")"

echo "=== Startup Script ==="

if [ ! -d "frontend/.next" ]; then
  echo "No production build found - building frontend (first run, this can"
  echo "take a while on a Pi Zero 2W)..."
  (cd frontend && npm ci && npm run build)
fi

echo "Stopping any existing PM2 processes..."

# Kill all existing PM2 processes
pm2 kill 2>/dev/null || true

# Small delay to ensure processes are fully stopped
sleep 2

echo "Starting PM2 processes..."

# Start all services using ecosystem config
pm2 start ecosystem.config.js

# Wait for processes to initialize
sleep 3

# Show status
echo ""
echo "=== PM2 Status ==="
pm2 list

echo ""
echo "=== Startup Complete ==="
echo "Frontend: http://localhost:3000"
echo "API:      http://localhost:3001"
echo "API Docs: http://localhost:3001/redoc"
echo ""
echo "View logs: pm2 logs"
