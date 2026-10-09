---
name: home-manager-service-logs
description: Read and interpret home-manager's (hue-manager) service logs and live state on the Raspberry Pi over SSH — journalctl for the scheduler and watchdog, what each log line prefix means, and the data files (schedules.json, switch-locks.json, heartbeat) to check alongside. Use when the scheduler "isn't doing" something in a room, lights keep drifting or bouncing, a dimmer lock seems not to work, or to confirm which commit is deployed.
---

# Reading home-manager service logs

Verified 2026-10-09 against the deployed Pi (`ak-rpi`, commit `c76123e`).

## Getting in

```bash
ssh amani@$RPI_IP          # RPI_IP is set in the local shell env (192.168.1.222)
```

`amani` is in the `adm` group, so `journalctl` works **without sudo**. The Pi
has `python3` but **no `jq`**. To pick JSON apart, either use
`python3 -c 'import json,sys; ...'` there, or copy the file back and use `jq`
locally:

```bash
ssh amani@$RPI_IP 'cat ~/home-manager/data/schedules.json' > "$SCRATCH/schedules.json"
```

## Units

`deploy/deploy.sh` installs these (the names come from `SERVICE_NAME="hue-manager"`):

| Unit | What it is |
|---|---|
| `hue-manager.service` | The Node backend (`npm run server`): HTTP API plus the per-minute scheduler. Logs land under `npm[<pid>]`. |
| `hue-manager-watchdog.timer` / `.service` | Every ~2 min, runs `deploy/watchdog.sh`. It restarts `hue-manager` if `data/scheduler-heartbeat` is older than 180s. |

```bash
systemctl show hue-manager -p ActiveState -p SubState -p ExecMainStartTimestamp
journalctl -u hue-manager --since "-1h" --no-pager
journalctl -u hue-manager -u hue-manager-watchdog.service -f      # follow both (what deploy.sh prints)
journalctl -u hue-manager --no-pager | grep "server running" | tail -1   # deployed commit, e.g. "(commit c76123e)"
```

Compare the running commit against `git -C ~/home-manager log -1`. A pull
without a restart means the code on disk isn't what's running.

**Timestamps:** the journal prefix is local time (CEST/CET), but the
`[scheduler] tick @ …` ISO strings are UTC.

## Log lines and what they mean

All of them come from `server/schedules.ts`, `server/switchLocks.ts` and `server/index.ts`.

| Line | Meaning |
|---|---|
| `[scheduler] tick @ <utc>: processed N schedule(s)` / `nothing to do` | One per minute. Gaps mean the tick loop stalled, and the watchdog should catch that. |
| `[scheduler] drift: group G (Name) light L bri=X target=Y` (or `ct=`, or `is on but scene target is off`) | During a static-scene slot, light L doesn't match the scene, so the scene is re-recalled on this tick. One line after a slot change is normal. **The same lines every minute** mean something keeps undoing the recall (see below). |
| `[scheduler] group G (...): smart scene still hasn't converged after 5 ticks` | A smart-scene slot gave up nudging lights until the next slot. |
| `[scheduler] group G missing from this tick's enriched groups` | A bridge lookup miss. It retries on the next tick. |
| `[switch-locks] <switch name>: locked` / `restored` | A dimmer was rewritten into, or back out of, a lock: silenced (kill switch or `off` slot), or pinned (power button pinned to the slot's scene). `locked` also shows up when a new slot re-pins the power button. These happen at slot and kill-switch boundaries, e.g. `locked` at 00:00 and `restored` at 23:55 when a room has a gap between slots. |
| `[switch-locks] <name> was reconfigured in the Hue app while locked` | Someone edited the switch in the Hue app. That new configuration becomes the "original". |
| `[switch-locks] sync failed:` / `[scheduler] tick failed:` | An exception, followed by a stack trace. |

Useful filters:

```bash
journalctl -u hue-manager --since today --no-pager | grep -v "tick @"            # everything but heartbeat noise
journalctl -u hue-manager --since today --no-pager | grep "drift: group 3" | head  # when did a room start drifting
journalctl -u hue-manager --since "-7d" --no-pager | grep switch-locks            # lock/restore history
```

## Data files on the Pi (`~/home-manager/data/`)

- `schedules.json`: per v1 group id, the `slots` (`startTime`/`endTime`,
  `sceneId`, `sceneType` static/smart/off), `killSwitch` and `autoOff`. Work
  out the active slot from the current local time.
- `switch-locks.json`: `silenced` lists the v1 group ids the app last
  silenced. `pinned` maps a v1 group id to the `{sceneId, sceneType}` its
  power button was last pinned to. `originals` holds each locked switch's
  pre-lock `behavior_instance` config. If a room is in `silenced`/`pinned`
  and its switch is in `originals`, the app believes that switch is
  locked. (Files written before 2026-10-09 have `killed`/`powerOnly` instead.)
  Those load as "no rooms", and the next tick reconciles them.
- `scheduler-heartbeat`: an ISO timestamp, rewritten after every tick.

## Debugging "the schedule isn't holding in room X"

1. Check the logs (above). Is the room drifting on every tick, and since when?
2. Check `switch-locks.json` and the `locked`/`restored` log lines. Is the room's switch locked?
3. Compare against the live bridge with the `hue-bridge-api` skill: the
   switch's `behavior_instance` buttons, the scene's targets, and the lights'
   current state.
4. If drift repeats every minute, **watch the bridge event stream** while the
   scheduler (or a manual `PUT {"scene": …}` on the group) recalls the scene.
   That shows *what* undoes it:

   ```bash
   timeout 60 curl -skN -H "hue-application-key: $HUE_USER" -H 'Accept: text/event-stream' \
     https://$HUE_IP/eventstream/clip/v2 | grep '^data:' | sed 's/^data: //' \
     | jq -c '.[]|.creationtime as $t|.data[]|select(.type=="button" or .type=="scene")
              |{t:$t,type,id,ev:.button.button_report.event,active:.status.active}'
   ```

   `button` events are physical presses on a switch. Map the id to a switch
   and position via `$V2/button` (`owner.rid` gives the device,
   `metadata.control_id` gives the position). `scene` events with
   `active: static` show which scene each press recalled.

Observed 2026-10-09 in Kontoret: drift lines every minute (bri=254 vs.
target 89) while the dimmer was locked to its power button only. The event
stream showed someone pressing the **power button** several times within
3s. Its "time based light" with smart on/off steps through every time
slot's scene on repeat presses, including the 100% daytime one. That's why
a scheduled room's power button is now pinned to the slot's single scene.
If this pattern shows up again, check whether the power button in the
switch's live config really has only one slot.
