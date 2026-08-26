#!/usr/bin/env bash
#
# Restarts the hue-manager service if the scheduler's heartbeat file (written
# by server/schedules.ts on every tick) has gone stale.
#
# Guards against a failure mode seen in production where the scheduler's
# internal timer silently stopped firing while the rest of the Node process
# (the HTTP server) kept running fine -- nothing inside that process could
# have noticed, since detecting it depends on the very timer that died. This
# runs as an independent systemd timer instead, so it doesn't share fate with
# whatever's broken.
#
# Installed by provision.sh as hue-manager-watchdog.timer/.service.

set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HEARTBEAT_FILE="$APP_DIR/data/scheduler-heartbeat"
MAX_AGE_SECONDS=180

now=$(date +%s)

if [[ -f "$HEARTBEAT_FILE" ]]; then
  last=$(date -r "$HEARTBEAT_FILE" +%s)
  age=$((now - last))
else
  age=$((MAX_AGE_SECONDS + 1))
fi

if (( age > MAX_AGE_SECONDS )); then
  echo "scheduler heartbeat is ${age}s old (max ${MAX_AGE_SECONDS}s) -- restarting hue-manager"
  systemctl restart hue-manager
else
  echo "scheduler heartbeat is ${age}s old -- ok"
fi
