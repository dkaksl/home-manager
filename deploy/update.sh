#!/usr/bin/env bash
#
# Pulls the latest backend code, reinstalls dependencies, and restarts the
# systemd service. Run on the Pi from the cloned repo:
#
#   ./deploy/update.sh

set -euo pipefail

APP_DIR="$HOME/home-manager"
SERVICE_NAME="hue-manager"

cd "$APP_DIR"
git pull
npm install
sudo systemctl restart "$SERVICE_NAME"

echo "==> Updated and restarted. Logs: journalctl -u $SERVICE_NAME -f"
