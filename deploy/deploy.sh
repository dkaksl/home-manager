#!/usr/bin/env bash
#
# Idempotent setup/upgrade script for the Hue Manager backend. Safe to run
# on a fresh Raspberry Pi (first-boot) or repeatedly on an existing install
# to pick up code or config changes -- same command either way.
#
# Fresh Pi, over SSH (flash the OS with SSH and your public key already
# configured -- Raspberry Pi Imager -> advanced options -- then boot it):
#
#   ssh <user>@<host> 'bash -s' < deploy/deploy.sh
#
# Existing install, from a clone on the device itself:
#
#   ./deploy/deploy.sh
#
# It installs Node.js if needed, pulls the repo, installs dependencies,
# (re)installs the systemd service and watchdog timer, and restarts them.
#
# On a genuinely fresh install there's no .env yet, so the service is left
# stopped -- copy one over and re-run (or just start it yourself):
#
#   scp .env <user>@<host>:~/home-manager/.env

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
# --no-audit: the post-install audit call to the registry has been observed
# to hang indefinitely on this device after packages are already fully
# installed, stalling the deploy for no benefit (a deploy is not the place
# to be blocked on a vulnerability report anyway).
npm install --no-audit

echo "==> Installing systemd units"
sed \
  -e "s|__USER__|$USER|g" \
  -e "s|__HOME__|$HOME|g" \
  -e "s|__NPM__|$(command -v npm)|g" \
  "$APP_DIR/deploy/hue-manager.service" | sudo tee "/etc/systemd/system/${SERVICE_NAME}.service" >/dev/null
sed \
  -e "s|__HOME__|$HOME|g" \
  "$APP_DIR/deploy/hue-manager-watchdog.service" | sudo tee "/etc/systemd/system/${SERVICE_NAME}-watchdog.service" >/dev/null
sudo cp "$APP_DIR/deploy/hue-manager-watchdog.timer" "/etc/systemd/system/${SERVICE_NAME}-watchdog.timer"

sudo systemctl daemon-reload
sudo systemctl enable "$SERVICE_NAME"
sudo systemctl enable --now "${SERVICE_NAME}-watchdog.timer"

# Follow-up commands worth having on hand right after a deploy.
STATUS_CMD="systemctl status $SERVICE_NAME ${SERVICE_NAME}-watchdog.timer"
LOGS_CMD="journalctl -u $SERVICE_NAME -u ${SERVICE_NAME}-watchdog.service -f"

if [[ -f "$APP_DIR/.env" ]]; then
  echo "==> Restarting $SERVICE_NAME"
  sudo systemctl restart "$SERVICE_NAME"
  cat <<EOF

==> Done. $SERVICE_NAME is running the latest code.

    Check status with: $STATUS_CMD
    Follow logs with:  $LOGS_CMD
EOF
else
  cat <<EOF

==> Done, but $APP_DIR/.env is missing -- $SERVICE_NAME was NOT started.

    Copy it over, then re-run this script (or just: sudo systemctl start $SERVICE_NAME)

      scp .env $USER@<host>:$APP_DIR/.env
EOF
fi
