#!/bin/bash
set -e

APP_DIR="/home/ubuntu/personal-assistant"

echo "=== Updating Personal Assistant Service ==="
cd "$APP_DIR"
npm install --production

echo "Reloading and restarting assistant.service..."
sudo systemctl daemon-reload
sudo systemctl restart assistant.service
sudo systemctl status assistant.service --no-pager

echo "=== Assistant Service Updated Successfully ==="
