#!/usr/bin/env bash
#
# First-boot setup for the Hue Manager backend on a Raspberry Pi.
#
# Flash the OS with SSH and your public key already configured (Raspberry Pi
# Imager -> advanced options), boot the Pi, then run this script over SSH:
#
#   ssh <user>@<host> 'bash -s' < deploy/provision.sh
#
# It installs Node.js, clones the repo, and registers the backend as a
# systemd service (enabled, but not started -- the .env file still needs to
# be copied over first, see the final message) along with a watchdog timer
# that restarts it if the scheduler's heartbeat goes stale.
#
# Safe to re-run on an already-provisioned Pi -- e.g. to pick up the watchdog
# timer on a install that predates it. It won't touch an existing .env or
# restart a running service.

set -euo pipefail

REPO_URL="https://github.com/dkaksl/home-manager.git"
APP_DIR="$HOME/home-manager"
SERVICE_NAME="hue-manager"

echo "==> Checking Node.js"
NODE_MAJOR=$(node --version 2>/dev/null | sed -E 's/^v([0-9]+).*/\1/' || echo 0)
if [[ "$NODE_MAJOR" -lt 24 ]]; then
  echo "    Installing Node.js 24.x via NodeSource"
  curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi

echo "==> Fetching repository"
if [[ -d "$APP_DIR/.git" ]]; then
  git -C "$APP_DIR" pull
else
  git clone "$REPO_URL" "$APP_DIR"
fi

echo "==> Installing dependencies"
cd "$APP_DIR"
npm install

echo "==> Installing systemd service"
sed \
  -e "s|__USER__|$USER|g" \
  -e "s|__HOME__|$HOME|g" \
  -e "s|__NPM__|$(command -v npm)|g" \
  "$APP_DIR/deploy/hue-manager.service" | sudo tee "/etc/systemd/system/${SERVICE_NAME}.service" >/dev/null

echo "==> Installing scheduler watchdog"
sed \
  -e "s|__HOME__|$HOME|g" \
  "$APP_DIR/deploy/hue-manager-watchdog.service" | sudo tee "/etc/systemd/system/${SERVICE_NAME}-watchdog.service" >/dev/null
sudo cp "$APP_DIR/deploy/hue-manager-watchdog.timer" "/etc/systemd/system/${SERVICE_NAME}-watchdog.timer"

sudo systemctl daemon-reload
sudo systemctl enable "$SERVICE_NAME"
sudo systemctl enable --now "${SERVICE_NAME}-watchdog.timer"

cat <<EOF

==> Done. Before starting the service, copy your .env file over:

      scp .env $USER@<host>:$APP_DIR/.env
      ssh $USER@<host> 'sudo systemctl start $SERVICE_NAME'

    Check status with: systemctl status $SERVICE_NAME
    Follow logs with:  journalctl -u $SERVICE_NAME -f

    Watchdog timer (restarts $SERVICE_NAME if the scheduler heartbeat goes
    stale) is enabled and running: systemctl status ${SERVICE_NAME}-watchdog.timer

    To upgrade later, run: $APP_DIR/deploy/update.sh
EOF
