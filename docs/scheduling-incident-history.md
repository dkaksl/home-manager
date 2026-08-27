# Scheduling feature: incident history

The room-scheduling feature ([server/schedules.ts](../server/schedules.ts)) has broken in
several distinct ways since it launched. Each fix addressed a real, separate failure mode
rather than the same bug recurring — this doc lays out what actually happened, in order,
based on git history and the `hue-manager` systemd journal on the Pi (`$RPI_IP`, single
boot since 2026-08-15).

## TL;DR — current state (2026-08-27, verified over SSH)

The scheduler is healthy and ticking normally. Five fixes have landed since launch, each
closing off one way a tick could silently die or misbehave. A sixth bug let a room get
stuck on the wrong scene for hours with zero error output; the fix for it
(`a7e6c60`, "fix: stuck scenes in scheduling") is committed but **not yet deployed** —
it hasn't been pushed to `origin` yet, so the Pi's `deploy.sh` (which does a plain
`git pull`) can't see it. Verified on the Pi:

```
$ git -C ~/home-manager log -1 --format="%H %s"
453c6f6b1ad2519c10015cb0e58d3a1267539e59 feat: log some useful commands on deploy
```

`453c6f6` is two commits behind `a7e6c60` on `main` — it predates the fix, it's not a
stale checkout. `git log --oneline origin/main` confirms `origin` itself only has up to
`453c6f6`; `a7e6c60` and the doc commit exist locally but were never pushed. The service
was in fact redeployed and restarted today at 10:11:59 CEST (`ExecMainStartTimestamp`),
so the deploy mechanism itself worked correctly — it just deployed the newest commit
that existed on the remote at the time, which doesn't include the fix.
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
| 08-27 | *(local, undeployed)* | **Incident 6** — fixed edge-trigger latch bug from `983cf9f` |

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

Fix (local, not yet deployed to the Pi): `lastActiveSlot` is now only latched once the
slot has actually been acted on — scene applied, off applied, or steady-state with a
resolved `group`. If `group` is missing that tick, the latch is left alone so the next
tick still sees `enteringSlot === true` and retries, instead of silently giving up for
the rest of the slot ([server/schedules.ts:271-297](../server/schedules.ts#L271-L297)).

## Recommendations / open items

- **Deploy the Incident 6 fix.** It's local-only as of this doc; Trapporna was fixed for
  today by manually re-pushing the scene via the bridge API, but the underlying bug is
  still live on the Pi until redeployed.
- **Every deploy-triggered restart in the journal required a `SIGKILL`**, not a graceful
  stop (`Killing process N (V8Worker/SignalInspector/DelayedTaskSche)` appears on every
  single restart since 08-16). Not scheduling-specific, but worth a separate look —
  `ts-node`/the TS compiler worker doesn't appear to exit cleanly on `SIGTERM`.
- **Silent skips still aren't logged.** The `group` lookup miss that caused Incident 6
  produces no log line even after the fix — the retry will happen, but there's no
  visibility into how often it occurs. Worth a `console.warn` when `group` is undefined
  for a schedule that's in `relevant`, so a recurring bridge issue is visible before it
  causes another stuck room.
