# Scheduling feature: incident history

The room-scheduling feature ([server/schedules.ts](../server/schedules.ts)) has broken in
several distinct ways since it launched. Each fix addressed a real, separate failure mode
rather than the same bug recurring — this doc lays out what actually happened, in order,
based on git history and the `hue-manager` systemd journal on the Pi (`$RPI_IP`, single
boot since 2026-08-15).

## TL;DR — current state (2026-08-27, verified over SSH)

The scheduler is healthy and ticking normally, and **all six fixes are now deployed**,
including the Incident 6 fix (`a7e6c60`, "fix: stuck scenes in scheduling"), which was
pushed to `origin` and redeployed after initially shipping local-only. Verified on the
Pi post-redeploy:

```
$ git -C ~/home-manager log -1 --format="%H %s"
08723413ee567ab9031d05c5c90d5e18410941e7 chore: updated docs   # descendant of a7e6c60
$ grep -n "leave the slot unlatched" ~/home-manager/server/schedules.ts
289:            // fetch miss) -- leave the slot unlatched so the next tick still
$ systemctl show hue-manager -p ActiveState -p SubState -p ExecMainStartTimestamp
ActiveState=active
SubState=running
ExecMainStartTimestamp=Thu 2026-08-27 10:13:40 CEST
```

Startup log confirms the running process is on the new code
(`Hue manager server running on http://localhost:3001 (commit 0872341)`), and the
heartbeat file was 1s old at check time — the scheduler is ticking on the fixed code.
See [Incident 6](#incident-6-2026-08-27--edge-trigger-latches-before-the-scene-is-actually-applied).

## Timeline

| Date (2026) | Commit | What |
|---|---|---|
| 06-06 | `fc57714` | Scheduling feature launched — naive `setInterval(tick, 60_000)`, no fetch timeouts, no flicker guard |
| 08-16 | `254d282` | Added kill switch, per-light manual-off preservation, motion/timer auto-off |
| 08-18 23:37 | — | **Incident 1** — uncaught bridge fetch error crashes the whole process |
| 08-22 | `983cf9f` | Fixed scene-recall flicker with an edit-triggered latch — **introduces the bug fixed in Incident 6** |
| 08-25 18:35 | `3044022` | **Incident 2** fix — added 10s timeouts to every Hue bridge fetch |
| 08-26 ~15:49–15:59 | — | **Incident 3** — debugger attached to the live process freezes the event loop |
| 08-26 15:58 | `5d72937` | **Incident 3** fix (part 1) — `setInterval` → self-rescheduling `setTimeout` + try/catch per tick |
| 08-26 16:08 | `ad1cba0` | **Incident 3** fix (part 2) — heartbeat file + independent systemd watchdog timer |
| 08-27 | `a7e6c60` *(deployed as of 10:13:40)* | **Incident 6** — fixed edge-trigger latch bug from `983cf9f` |
| 09-02 | *(uncommitted)* | **Incident 7** — a separate, real bug found while investigating: adjacent slots sharing a scene re-trigger a recall at the boundary |
| 09-02 | *(uncommitted)* | **Incident 8** — actual root cause of the "Nere" flicker report: an unreachable `ct` target caused a scene recall (and drift-check false positive) on every tick |

## Incident 1 — 2026-08-18 23:37: uncaught fetch error kills the process

```
23:37:05  [scheduler] group 82: [TypeError: fetch failed] { [cause]: Error: read ECONNRESET ... }
23:37:25  [TypeError: fetch failed] { [cause]: Error: read ECONNRESET ... }
23:37:25  hue-manager.service: Main process exited, code=exited, status=1/FAILURE
23:37:30  hue-manager.service: Scheduled restart job, restart counter is at 1.
23:37:36  [scheduler] starting, first tick in 23s
```

Two `ECONNRESET`s from the Hue bridge 20s apart. The first was caught inside the
per-schedule `try/catch` in `tick()` (note the `group 82:` prefix) and the tick moved on.
The second happened in code that ran *before* the per-schedule loop — the initial
`Promise.all([getEnrichedGroups(), ...])` — which at the time had no surrounding
`try/catch` at all. An uncaught rejection there is fatal to a Node process by default, so
the whole `hue-manager` process exited. `systemd` (`Restart=on-failure`, `RestartSec=5`)
brought it back in ~5s, so the outage was brief and self-healing — but silent: nothing
about it stood out from a normal deploy restart except the log line above.

Not fixed until a week later, indirectly, by `3044022` and `5d72937` below.

## Incident 2 — fixed by `3044022` (2026-08-25, "fix: bug on timeouts")

Every Hue bridge call in [server/hue.ts](../server/hue.ts) originally used a bare `fetch(...)`
with no timeout. A bridge that stalls instead of erroring (no response, connection just
hangs) would leave that `fetch` pending forever. Because Node/undici share a connection
pool, a single wedged request queues every subsequent request behind it — silently
blocking every future tick too, indefinitely, with no crash and no log line.

Fix: `AbortSignal.timeout(10_000)` added to every bridge fetch
([server/hue.ts:13-14](../server/hue.ts#L13-L14)), so a stalled bridge now fails fast
instead of hanging the scheduler forever.

## Incident 3 — 2026-08-26 ~15:49–15:59: debugger attach freezes the event loop

```
15:49:00  Debugger listening on ws://127.0.0.1:9229/...
15:49:43  Debugger attached. / Debugger ending on ws://...
15:52:01  Debugger attached. / Debugger ending on ws://...
15:52:13  Debugger attached. / Debugger ending on ws://...
15:59:15  hue-manager.service: Killing process 18146 (DelayedTaskSche) with signal SIGKILL.
15:59:15  Stopped hue-manager.service / Started hue-manager.service
```

Something (most likely a VS Code "Attach to Node Process" session against the live Pi
process while [schedules.ts](../server/schedules.ts) was being edited) attached a Node
inspector to the running production process and paused it. `ts-node server/index.ts` was
started with no `--inspect` flag ([package.json](../package.json), systemd unit
[deploy/hue-manager.service](../deploy/hue-manager.service)) — this was a dynamic attach,
not a config issue.

Pausing on a breakpoint stops the whole V8 event loop, including the `setInterval`-driven
tick timer. The process kept `Active: active (running)` in systemd the entire time — a
paused-but-alive process never exits, so `Restart=on-failure` never triggers — and the
scheduler simply stopped ticking with no error output. It had to be manually `SIGKILL`ed
at 15:59:15 because it wouldn't respond to a graceful stop while wedged.

This is exactly the class of failure the `5d72937` code comment describes: *"ticks
stopped firing for days with zero error output, root cause never pinned down"* — the
journal here only covers this boot (since 2026-08-15), so that specific earlier
multi-day occurrence isn't independently verifiable from these logs, but the mechanism
(silent `setInterval` death, undetectable from inside the same process) is the same one
observed live on 08-26.

Two fixes landed back-to-back in response:

**`5d72937` (15:58:30, "fix: scheduling dying on unexpected errors")** —
`setInterval(tick, 60_000)` was replaced with a self-rescheduling `setTimeout`
([server/schedules.ts:306-320](../server/schedules.ts#L306-L320)): the next tick is only
armed after the current one settles, inside a `try/catch`. One bad tick — a thrown error,
a rejected promise — can no longer silently take the whole loop down the way an uncaught
exception inside a bare `setInterval` callback does. Tick start/end logging was also added
here, which is why every subsequent incident (including Incident 6) is traceable in the
journal and earlier ones aren't.

Note: this fix hardens against a *crashing* tick. It does not, and cannot, protect
against the *paused-event-loop* mechanism that actually caused this specific incident —
that needed an external detector, which is what `ad1cba0` added next.

**`ad1cba0` (16:08:20, "feat: added watchdog")** — a heartbeat file is now written after
every tick attempt, success or failure
([server/schedules.ts:15-21](../server/schedules.ts#L15-L21), written in `runTick`'s
`finally`). An independent systemd timer, `hue-manager-watchdog.timer`, runs every 2
minutes ([deploy/hue-manager-watchdog.timer](../deploy/hue-manager-watchdog.timer)) and
force-restarts `hue-manager` if the heartbeat is older than 180s
([deploy/watchdog.sh](../deploy/watchdog.sh)). This runs as a separate process, so it
doesn't share fate with whatever's wedged inside `hue-manager` — including a paused event
loop that the process itself has no way to notice.

As of 2026-08-27, the watchdog has been active for ~17h and has never needed to restart
the service (every 2-minute check has found the heartbeat fresh).

## Incident 6 — 2026-08-27: edge-trigger latches before the scene is actually applied

Room "Trapporna" (group 7) was still showing last night's Nightlight scene
(`bri:1, ct:446`) at 09:20, three hours after it should have switched to the "Read" scene
at 06:00. No errors were logged; the scheduler had been ticking normally the whole time.

Root cause, introduced by `983cf9f` (Incident-2-era flicker fix, see below) and living
undetected for 5 days: in `tick()`, the per-room "have we already applied this slot"
bookkeeping was written unconditionally, before checking whether the scene was actually
applied:

```js
const enteringSlot = currSlotId !== prevSlotId
lastActiveSlot.set(schedule.groupId, currSlotId)   // written regardless

if (slot) {
  if (slot.sceneType === 'off') {
    await setGroupAction(schedule.groupId, { on: false })
  } else if (group && enteringSlot) {               // application requires `group`
    await applySceneSlot(schedule.groupId, slot, group, hasLinkedSwitch)
  }
}
```

`group` is looked up fresh every tick (`groups?.find(g => g.id === schedule.groupId)`,
[server/schedules.ts:251](../server/schedules.ts#L251)). If that lookup misses for one
tick — a plausible transient Hue bridge hiccup, given Incident 1 already shows this
bridge does occasionally drop requests — right as a slot boundary is crossed, the map
still gets marked "slot entered," but the `group &&` guard means the scene recall never
fires. Nothing throws, so nothing is logged. Every tick after that sees
`enteringSlot === false` and does nothing, because the edge-trigger has no memory of
"latched but never actually applied." The room stays stuck until the *next* slot boundary
(here, 20:00 that evening) finally forces a new edge.

Confirmed by manually replaying the exact bridge call the scheduler makes
(`PUT /groups/7/action {"scene":"<Read scene id>"}`) — it worked instantly, and the
scheduler didn't fight or revert it over the following ticks, proving the in-memory latch
was the thing stuck, not the bridge, scene config, or network path.

Fix: `a7e6c60` ("fix: stuck scenes in scheduling") — `lastActiveSlot` is now only latched
once the slot has actually been acted on — scene applied, off applied, or steady-state
with a resolved `group`. If `group` is missing that tick, the latch is left alone so the
next tick still sees `enteringSlot === true` and retries, instead of silently giving up
for the rest of the slot ([server/schedules.ts:271-297](../server/schedules.ts#L271-L297)).

**Deployed** — see [TL;DR](#tldr--current-state-2026-08-27-verified-over-ssh): pushed to
`origin` and redeployed; the Pi is now running `0872341`, a descendant of `a7e6c60`, and
the fix's code is confirmed present in the file on disk.

## Incident 7 — 2026-09-02: same-scene slot boundary re-triggers a recall, flickering manually-off lights

Reported: two lights in room "Nere" (group 1) that had been manually turned off overnight,
while the "Nightlight" scene was active, flickered on and then went off again. Initial
report from memory ("I thought we fixed this already") pointed at the class of bug
Incident 6 covers. This turned out to be a **real, separate bug** found while
investigating — but not the one that actually caused the reported flicker; see Incident 8
below for that. Documented here anyway since it's a genuine defect with its own fix and
test, distinct from both Incident 6 and Incident 8.

The room's schedule (`data/schedules.json` on the Pi) has two separate slots that both
point at the same static scene, `X6BUTnsmlSdSdrX` ("Nightlight"): 21:00–23:55 and
00:00–06:00. Confirmed via the bridge (`GET /scenes/X6BUTnsmlSdSdrX`) that this scene
targets all 5 of the room's lights `on:true`, and that group 1 has a linked switch (sensor
`2`, "Hue dimmer nere"), so `respectManualOff` is true for this room — the journal itself
had nothing to show, since neither a scene recall nor a drift correction logged anything at
the time (see Incident 8, which closes that gap).

Root cause, present since `983cf9f`/`a7e6c60` and not something Incident 6 touched: the
entering-a-slot check compared `TimeSlot.id`, not the scene it points at
([server/schedules.ts:291-293](../server/schedules.ts#L291-L293), pre-fix). At the 00:00
boundary the active `TimeSlot` object changes (a new slot with a new `id` becomes active)
even though its `sceneId`/`sceneType` are identical to the slot that was just active. That
made `enteringSlot` true, which forces `needsApply = true` unconditionally
(`processSchedule`'s static-scene drift check is only consulted `if (!needsApply)` — see
[server/schedules.ts:305-309](../server/schedules.ts#L305-L309), pre-fix) — a full
`applySceneSlot` call even though nothing about the desired state changed.
`applySceneSlot` recalls the scene on the whole group (turning every light in it on,
including the two the user had switched off), then restores the previously-off lights
after a 500ms sleep. That restore is the *intended* short flicker for a genuine slot
change ([server/schedules.ts:192-197](../server/schedules.ts#L192-L197)) — but firing it at
a boundary where the scene didn't actually change is pure regression, and for a `smart`
scene this same path would additionally restart its dynamic cycling on the bridge, per the
existing comment at [server/schedules.ts:63](../server/schedules.ts#L63) (pre-fix).

Fix (uncommitted): the latch (`lastActiveSlot`, renamed `lastAppliedScene`) is now keyed on
`` `${slot.sceneType}:${slot.sceneId}` `` instead of `slot.id`
([server/schedules.ts:63-72](../server/schedules.ts#L63-L72)). Two adjacent slots with the
same scene no longer look like an "entering" transition, so no recall fires and no
manually-off light gets flicked on. Covered by a new scenario test,
`schedules.test.ts`: "crossing into a new slot that shares the previous slot's scene does
not re-flicker a manually-off light" — confirmed it fails against the pre-fix code
(2 `activateScene` calls instead of 1) and passes against the fix. `npm test` and
`npx tsc --noEmit -p .` both pass.

**Not yet deployed** — this fix is only in the local working tree as of 2026-09-02; it
still needs to be committed, pushed, and redeployed to the Pi before tonight's Nightlight
slots.

## Incident 8 — 2026-09-02: an unreachable `ct` target drives a scene recall every tick, flickering any manually-off light in the room

The actual explanation for the Incident 7 report: the user clarified the flicker wasn't a
single blip at a slot boundary — it repeated every ~60s tick, continuously, for 2–3
minutes, and only stopped once they gave up and left the two lights on. That ruled out
Incident 7's mechanism (which can only fire once, at a boundary) and pointed at the
mid-slot drift-correction path instead (`sceneStateMatches`,
[server/schedules.ts](../server/schedules.ts)), which runs on *every* tick a static scene
is active.

Confirmed live against the real bridge (`$RPI_IP`, group 1, 23:13 on 2026-09-02, well
inside the 21:00–23:55 Nightlight slot):

```
$ curl .../lights/2   # "Matbordet", IKEA TRÅDFRI bulb
{"state": {"on": true, "bri": 1, "ct": 454, ...}, "capabilities": {"control": {"ct": {"min": 250, "max": 454}}}, ...}
```

The "Nightlight" scene's stored target for lights `2` ("Matbordet") and `5` ("Bokhylla") —
both the same IKEA TRÅDFRI model — is `ct: 500`. Both bulbs' hardware caps out at `ct: 454`
([capabilities.control.ct.max](../server/hue.ts)); the bridge silently clamps any request
past that and reports back the clamped value, which sits 46 mireds outside
`sceneStateMatches`'s ±1 tolerance. That makes the drift check return false — for these two
lights specifically — on *every single tick* the Nightlight scene is active, regardless of
what else in the room is doing. That is a group-level recall: it doesn't matter which two
lights the user manually switched off, since a mismatch anywhere in the scene's lightstates
forces `applySceneSlot` to run on the whole group again. A repeated identical recall is
invisible when everything's already at the (achievable) target — but it forces every
manually-off light in the room back on and then off again, every tick, for as long as it's
left off. This fully explains the report, including why it stopped the moment the user
left the two lights on (nothing left to visibly correct, whether or not the underlying
per-tick recall of lights `2`/`5` kept happening silently in the background).

No log line existed to distinguish this from a real, fixable drift — `sceneStateMatches`
only returned a boolean. Confirmed by directly reasoning through the code plus the one live
bridge check above; not confirmed from the journal, since nothing was logged at the time.

Fix:
- `sceneStateMatches` now clamps a scene's `ct` target into the light's own reported
  `capabilities.control.ct` range before comparing
  ([server/schedules.ts:90-148](../server/schedules.ts#L90-L148)), so a light that's
  already at the closest it can physically get no longer reads as permanently drifted.
  `Light` gained an optional `capabilities` field to carry this
  ([server/hue.ts](../server/hue.ts)) — the bridge already returns it, this just types it.
- Every remaining mismatch (a genuine, fixable drift) is now logged via `console.warn`,
  naming the group, light, and attribute, so a recurrence — this class or a new one — is
  diagnosable from `journalctl -u hue-manager | grep drift` without another live bridge
  session.
- The `!group` lookup-miss branch (an open item from Incident 6) now also logs, closing
  that gap too.

Covered by a new scenario test, `schedules.test.ts`: "a light whose hardware ct range falls
short of the scene target is not treated as permanent drift" — confirmed it fails against
the pre-fix comparison (2 `activateScene` calls instead of 1, i.e. the false drift
re-triggers a recall) and passes with the clamp. `npm test` (14/14) and
`npx tsc --noEmit -p .` both pass.

**Not yet deployed** — uncommitted, alongside the Incident 7 fix, as of 2026-09-02.

## Recommendations / open items

- **Every deploy-triggered restart in the journal required a `SIGKILL`**, not a graceful
  stop (`Killing process N (V8Worker/SignalInspector/DelayedTaskSche)` appears on every
  single restart since 08-16). Not scheduling-specific, but worth a separate look —
  `ts-node`/the TS compiler worker doesn't appear to exit cleanly on `SIGTERM`.
- ~~**Silent skips still aren't logged.**~~ Closed by Incident 8: the `group` lookup miss
  from Incident 6 and every static-scene drift mismatch now log via `console.warn`.
