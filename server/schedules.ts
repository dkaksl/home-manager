import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import path from 'path'
import {
  getEnrichedGroups,
  getSensors,
  getSwitchSensorIds,
  setGroupAction,
  setLightState,
  activateScene,
  activateSmartScene,
  getSceneLightstates,
  getSmartSceneTargetLightstates,
  EnrichedGroup,
  SceneLightState
} from './hue'

const SCHEDULES_FILE = path.join(process.cwd(), 'data', 'schedules.json')

// Written on every tick attempt so an external watchdog (deploy/watchdog.sh,
// run via systemd timer, independent of this process's own event loop) can
// detect the one failure mode this process can never notice on its own: the
// timer that's supposed to call tick() every 60s silently stops firing.
// Nothing inside the process runs in that case, so nothing inside the
// process can catch it either.
const HEARTBEAT_FILE = path.join(process.cwd(), 'data', 'scheduler-heartbeat')

export interface TimeSlot {
  id: string
  startTime: string // "HH:MM"
  endTime: string // "HH:MM" exclusive
  sceneId: string // scene id, or 'off'
  sceneType: 'static' | 'smart' | 'off'
}

export interface AutoOffConfig {
  enabled: boolean
  timeoutMinutes: number
  sensorId: string | null // null = plain timer (off N min after the room turns on)
}

export interface RoomSchedule {
  groupId: string
  enabled: boolean
  slots: TimeSlot[]
  killSwitch?: boolean
  autoOff?: AutoOffConfig
}

// Scheduler-owned runtime state for auto-off timing. Intentionally not
// persisted to schedules.json — it's derived from live bridge state each
// tick, not user config, and must not be clobbered by a client save.
interface ActivityAnchor {
  turnedOnAt: number | null
  lastMotionAt: number | null
}
const activityAnchors = new Map<string, ActivityAnchor>()

// Tracks, per room, the (type, sceneId) of the scene last applied, so
// processSchedule can tell "just crossed into a different scene" from "been
// here a while" (see schedules.test.ts for the entering/steady-state/retry
// scenarios this drives). Keyed on the scene itself rather than the
// `TimeSlot.id` it came from: two adjacent slots that happen to reference the
// same scene (e.g. a room's evening and pre-dawn slots both set to
// "Nightlight") must not look like an "entering" transition just because the
// slot object changed underneath an unchanged scene — that forced a needless
// scene recall right at the boundary, which flickered on any light a person
// had manually turned off, exactly the class of bug the edit-triggered latch
// (983cf9f) was meant to prevent. Smart scenes are only ever touched on
// entry — re-activating one mid-slot would restart its dynamic cycling on
// the Hue bridge, not just resend the same state.
const lastAppliedScene = new Map<string, string | null>()

const sceneKey = (slot: TimeSlot | undefined): string | null =>
  slot ? `${slot.sceneType}:${slot.sceneId}` : null

// Per-scene target lightstates, fetched once and reused — scenes rarely
// change, and re-verifying drift every tick shouldn't cost an extra bridge
// round trip per schedule every time.
const sceneLightstateCache = new Map<string, Record<string, SceneLightState>>()

const getCachedSceneLightstates = async (
  sceneId: string
): Promise<Record<string, SceneLightState>> => {
  const cached = sceneLightstateCache.get(sceneId)
  if (cached) return cached
  const lightstates = await getSceneLightstates(sceneId)
  sceneLightstateCache.set(sceneId, lightstates)
  return lightstates
}

// `ct` is compared with a 1-mired tolerance since the bridge rounds it on
// readback (exact equality would flag drift that isn't real).
//
// A `ct` target is also clamped to the light's own reported range before
// that comparison. A scene can store a `ct` past what a given bulb's
// hardware actually supports (this happened for real: two IKEA TRÅDFRI
// bulbs in "Nere" have a `ct` max of 454, but the "Nightlight" scene's
// stored target for them is 500 -- see docs/scheduling-incident-history.md,
// Incident 7). The bridge silently clamps that on recall and reports back
// whatever the bulb actually settled at, which without clamping the target
// here first would never satisfy the tolerance -- making this function
// return false on *every* tick for as long as that scene is active, driving
// a full scene re-recall every tick. That's invisible on its own (resending
// a state a light is already at doesn't visibly change anything), but it
// flickers any *other* light a person has manually turned off in the same
// room, every tick, for as long as they leave it off -- the whole group's
// scene gets re-recalled regardless of which light in it is the one that
// won't settle.
//
// Every remaining mismatch (a light that isn't hardware-limited, but is
// still off-target) is logged, so a real drift is distinguishable from this
// class of false positive without another live bridge inspection.
const clampToRange = (value: number, range?: { min: number; max: number }): number =>
  range ? Math.min(range.max, Math.max(range.min, value)) : value

interface LightMismatch {
  id: string
  target: SceneLightState
}

// Shared by the static-scene drift check and the smart-scene convergence
// check below: both need to know exactly which lights don't match a set of
// target lightstates yet, not just whether the room as a whole matches.
const findLightMismatches = (
  group: EnrichedGroup,
  lightstates: Record<string, SceneLightState>,
  respectManualOff: boolean
): LightMismatch[] => {
  const mismatches: LightMismatch[] = []

  for (const [lightId, target] of Object.entries(lightstates)) {
    const light = group.lightDetails.find((l) => l.id === lightId)
    if (!light) continue // can't verify a light we don't see this tick

    if (!light.state.on) {
      if (!respectManualOff) mismatches.push({ id: lightId, target })
      continue
    }
    if (!target.on) {
      console.warn(
        `[scheduler] drift: group ${group.id} (${group.name}) light ${lightId} is on but scene target is off`
      )
      mismatches.push({ id: lightId, target })
      continue
    }
    if (
      target.bri !== undefined &&
      Math.abs((light.state.bri ?? 0) - target.bri) > 1
    ) {
      console.warn(
        `[scheduler] drift: group ${group.id} (${group.name}) light ${lightId} bri=${light.state.bri} target=${target.bri}`
      )
      mismatches.push({ id: lightId, target })
      continue
    }
    if (target.ct !== undefined) {
      const achievableCt = clampToRange(target.ct, light.capabilities?.control?.ct)
      if (Math.abs((light.state.ct ?? 0) - achievableCt) > 1) {
        console.warn(
          `[scheduler] drift: group ${group.id} (${group.name}) light ${lightId} ct=${light.state.ct} target=${target.ct}`
        )
        mismatches.push({ id: lightId, target })
      }
    }
  }

  return mismatches
}

const sceneStateMatches = (
  group: EnrichedGroup,
  lightstates: Record<string, SceneLightState>,
  respectManualOff: boolean
): boolean => findLightMismatches(group, lightstates, respectManualOff).length === 0

// How many ticks after entering a smart-scene slot to keep checking whether
// the room actually reached the scene's target, before giving up. Confirmed
// live (see docs/scheduling-incident-history.md, Incident 9): a smart
// scene's `recall: activate` can land on the bridge but not fully propagate
// to every light in one shot -- two IKEA TRÅDFRI bulbs stayed at the
// overnight scene's brightness for several minutes after the slot switched,
// while the room's other lights updated immediately. Smart scenes are
// otherwise never touched again after entry (re-activating one mid-slot
// would restart its bridge-side cycling, per `applySceneSlot`'s comment), so
// without this a partial recall would stay wrong for the rest of the slot.
const SMART_SCENE_CONVERGENCE_TICKS = 5

interface SmartSceneConvergence {
  sceneKey: string | null
  ticksRemaining: number
}
const smartSceneConvergence = new Map<string, SmartSceneConvergence>()

// Nudges any light that hasn't caught up to the smart scene's current target
// directly via `setLightState`, rather than re-sending `activateSmartScene`
// -- a direct per-light push can't restart the smart scene's own dynamic
// cycling the way re-activating the whole scene would. Bounded to
// `SMART_SCENE_CONVERGENCE_TICKS` ticks so a light that's stuck for a real
// reason (unreachable, bridge issue) doesn't get fought forever; a lingering
// mismatch after that is logged instead, same as static-scene drift.
const verifySmartSceneConvergence = async (
  groupId: string,
  slot: TimeSlot,
  group: EnrichedGroup,
  respectManualOff: boolean,
  currSceneKey: string | null
): Promise<void> => {
  const convergence = smartSceneConvergence.get(groupId)
  if (!convergence || convergence.sceneKey !== currSceneKey) return

  const lightstates = await getSmartSceneTargetLightstates(slot.sceneId)
  const mismatches = findLightMismatches(group, lightstates, respectManualOff)

  if (!mismatches.length) {
    smartSceneConvergence.delete(groupId)
    return
  }

  if (convergence.ticksRemaining <= 1) {
    console.warn(
      `[scheduler] group ${groupId} (${group.name}): smart scene still hasn't converged after ${SMART_SCENE_CONVERGENCE_TICKS} ticks -- giving up until the next slot change`
    )
    smartSceneConvergence.delete(groupId)
    return
  }

  convergence.ticksRemaining -= 1
  await Promise.all(
    mismatches.map(({ id, target }) =>
      setLightState(id, {
        on: target.on,
        ...(target.bri !== undefined && { bri: target.bri }),
        ...(target.ct !== undefined && { ct: target.ct })
      })
    )
  )
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const load = (): Record<string, RoomSchedule> => {
  if (!existsSync(SCHEDULES_FILE)) return {}
  try {
    return JSON.parse(readFileSync(SCHEDULES_FILE, 'utf8'))
  } catch {
    return {}
  }
}

const persist = (data: Record<string, RoomSchedule>) => {
  mkdirSync(path.dirname(SCHEDULES_FILE), { recursive: true })
  writeFileSync(SCHEDULES_FILE, JSON.stringify(data, null, 2))
}

export const getSchedules = () => load()

export const setSchedule = (groupId: string, schedule: RoomSchedule) => {
  const data = load()
  data[groupId] = { ...schedule, groupId }
  persist(data)
}

const toMin = (hhmm: string): number => {
  const [h, m] = hhmm.split(':').map(Number)
  return h * 60 + m
}

// A light belongs to exactly one Room, but can also be pulled into any
// number of Zones/Entertainment groups that carve out a subset of a room's
// lights (e.g. "Vardagsrum" is a zone over lights that live in the "Nere"
// room). A switch is only ever linked to the owning Room, never to those
// derived zones — so whether a group's lights sit behind a switch has to be
// resolved back to each light's owning Room, not read off the group being
// scheduled directly.
const computeSwitchCoverage = (
  groups: Awaited<ReturnType<typeof getEnrichedGroups>>,
  switchSensorIds: Set<string>
): Map<string, boolean> => {
  const switchByLight = new Map<string, boolean>()
  for (const g of groups) {
    if (g.type !== 'Room') continue
    const hasSwitch = g.sensors.some((id) => switchSensorIds.has(id))
    for (const lightId of g.lights) switchByLight.set(lightId, hasSwitch)
  }

  const coverage = new Map<string, boolean>()
  for (const g of groups) {
    coverage.set(
      g.id,
      g.lights.length > 0 && g.lights.every((id) => switchByLight.get(id))
    )
  }
  return coverage
}

const inSlot = (nowMin: number, slot: TimeSlot): boolean => {
  const s = toMin(slot.startTime)
  const e = toMin(slot.endTime)
  // Handle midnight-crossing slots (e.g. 23:00 → 01:00)
  return s <= e ? nowMin >= s && nowMin < e : nowMin >= s || nowMin < e
}

// `respectManualOff` is false for rooms with no linked wall switch (see
// `getSwitchSensorIds`), since a breaker-only room's "off" bridge state can't
// be trusted as a deliberate override — there's no switch to press, and
// flipping the breaker back on doesn't restore the bridge's own on-flag.
// See schedules.test.ts for the room-level and light-level cases.
const applySceneSlot = async (
  groupId: string,
  slot: TimeSlot,
  group: Awaited<ReturnType<typeof getEnrichedGroups>>[number],
  respectManualOff: boolean
) => {
  if (respectManualOff && !group.state.any_on) return

  const offLightIds = respectManualOff
    ? group.lightDetails.filter((l) => !l.state.on).map((l) => l.id)
    : []

  if (slot.sceneType === 'smart') {
    await activateSmartScene(slot.sceneId)
  } else {
    await activateScene(groupId, slot.sceneId)
  }

  if (offLightIds.length) {
    // Give the bridge a moment to finish propagating the group recall
    // before we push the off-lights back down, to avoid an on/off flicker.
    await sleep(500)
    await Promise.all(offLightIds.map((id) => setLightState(id, { on: false })))
  }
}

// Sensor mode: the anchor is pushed forward on every detected motion, so the
// room stays on indefinitely while occupied and only counts down once
// presence stops. Timer mode: the anchor is fixed at the off→on transition,
// so the room always turns off `timeoutMinutes` after being switched on.
// Returns true if it turned the room off — callers must skip any scene-slot
// logic for this room in the same tick, since that would otherwise act on a
// pre-write `group` snapshot that still shows the room as on and immediately
// undo the auto-off.
const applyAutoOff = async (
  schedule: RoomSchedule,
  group: Awaited<ReturnType<typeof getEnrichedGroups>>[number],
  sensors: Awaited<ReturnType<typeof getSensors>> | null,
  now: number
): Promise<boolean> => {
  const cfg = schedule.autoOff!
  const anchor = activityAnchors.get(schedule.groupId) ?? {
    turnedOnAt: null,
    lastMotionAt: null
  }

  if (!group.state.any_on) {
    anchor.turnedOnAt = null
    anchor.lastMotionAt = null
    activityAnchors.set(schedule.groupId, anchor)
    return false
  }

  let turnedOff = false

  if (cfg.sensorId) {
    const sensor = sensors?.find((s) => s.id === cfg.sensorId)
    if (sensor?.state.presence) {
      anchor.lastMotionAt = now
    } else if (anchor.lastMotionAt === null) {
      // No motion observed yet since the room turned on — start the idle
      // clock now rather than never firing.
      anchor.lastMotionAt = now
    }
    const idleMs = now - anchor.lastMotionAt
    if (idleMs >= cfg.timeoutMinutes * 60_000) {
      await setGroupAction(schedule.groupId, { on: false })
      anchor.lastMotionAt = null
      turnedOff = true
    }
  } else {
    if (anchor.turnedOnAt === null) anchor.turnedOnAt = now
    const onMs = now - anchor.turnedOnAt
    if (onMs >= cfg.timeoutMinutes * 60_000) {
      await setGroupAction(schedule.groupId, { on: false })
      anchor.turnedOnAt = null
      turnedOff = true
    }
  }

  activityAnchors.set(schedule.groupId, anchor)
  return turnedOff
}

export const processSchedule = async (
  schedule: RoomSchedule,
  group: EnrichedGroup | undefined,
  sensors: Awaited<ReturnType<typeof getSensors>> | null,
  switchCoverage: Map<string, boolean> | null,
  now: Date
): Promise<void> => {
  if (schedule.killSwitch) {
    if (group?.state.any_on) {
      await setGroupAction(schedule.groupId, { on: false })
    }
    return
  }

  if (schedule.autoOff?.enabled && group) {
    const turnedOff = await applyAutoOff(schedule, group, sensors, now.getTime())
    if (turnedOff) return
  }

  if (schedule.enabled && schedule.slots.length) {
    const nowMin = now.getHours() * 60 + now.getMinutes()
    const slot = schedule.slots.find((s) => inSlot(nowMin, s))

    const prevSceneKey = lastAppliedScene.get(schedule.groupId) ?? null
    const currSceneKey = sceneKey(slot)
    const enteringSlot = currSceneKey !== prevSceneKey

    if (slot) {
      if (slot.sceneType === 'off') {
        await setGroupAction(schedule.groupId, { on: false })
        lastAppliedScene.set(schedule.groupId, currSceneKey)
      } else if (!group) {
        console.warn(
          `[scheduler] group ${schedule.groupId} missing from this tick's enriched groups -- skipping, will retry next tick`
        )
        // Left unlatched deliberately (see schedules.test.ts, "retries after
        // a group lookup miss") -- do not set lastAppliedScene here.
      } else {
        const hasLinkedSwitch = switchCoverage?.get(schedule.groupId) ?? false

        let needsApply = enteringSlot
        if (!needsApply && slot.sceneType === 'static') {
          const lightstates = await getCachedSceneLightstates(slot.sceneId)
          needsApply = !sceneStateMatches(group, lightstates, hasLinkedSwitch)
        }

        if (needsApply) {
          await applySceneSlot(schedule.groupId, slot, group, hasLinkedSwitch)
          if (slot.sceneType === 'smart') {
            smartSceneConvergence.set(schedule.groupId, {
              sceneKey: currSceneKey,
              ticksRemaining: SMART_SCENE_CONVERGENCE_TICKS
            })
          }
        } else if (slot.sceneType === 'smart') {
          await verifySmartSceneConvergence(
            schedule.groupId,
            slot,
            group,
            hasLinkedSwitch,
            currSceneKey
          )
        }
        lastAppliedScene.set(schedule.groupId, currSceneKey)
      }
    } else {
      lastAppliedScene.set(schedule.groupId, currSceneKey)
    }
  }
}

const tick = async () => {
  const tickStart = new Date()
  const data = load()
  const relevant = Object.values(data).filter(
    (s) =>
      s.killSwitch || s.autoOff?.enabled || (s.enabled && s.slots.length > 0)
  )
  if (!relevant.length) {
    console.log(`[scheduler] tick @ ${tickStart.toISOString()}: nothing to do`)
    return
  }

  const now = tickStart

  const needsGroups = relevant.some(
    (s) => s.killSwitch || s.autoOff?.enabled || s.enabled
  )
  const needsSensors = relevant.some(
    (s) => s.autoOff?.enabled && s.autoOff.sensorId
  )

  const [groups, sensors, switchSensorIds] = await Promise.all([
    needsGroups ? getEnrichedGroups() : Promise.resolve(null),
    needsSensors ? getSensors() : Promise.resolve(null),
    needsGroups ? getSwitchSensorIds() : Promise.resolve(null)
  ])

  const switchCoverage =
    groups && switchSensorIds
      ? computeSwitchCoverage(groups, switchSensorIds)
      : null

  for (const schedule of relevant) {
    const group = groups?.find((g) => g.id === schedule.groupId)

    try {
      await processSchedule(schedule, group, sensors, switchCoverage, now)
    } catch (err) {
      console.error(`[scheduler] group ${schedule.groupId}:`, err)
    }
  }

  console.log(
    `[scheduler] tick @ ${tickStart.toISOString()}: processed ${relevant.length} schedule(s)`
  )
}

// Self-rescheduling setTimeout rather than setInterval: the next tick is
// only armed once the current one has fully settled (success or failure),
// via a fresh timer each time. That way one bad tick can never silently
// take the whole loop down with it — setInterval's single long-lived timer
// did exactly that in production (ticks stopped firing for days with zero
// error output, root cause never pinned down), whereas this can only stop
// if a tick throws synchronously, which the try/catch below also rules out.
const runTick = async () => {
  try {
    await tick()
  } catch (err) {
    console.error('[scheduler] tick failed:', err)
  } finally {
    try {
      mkdirSync(path.dirname(HEARTBEAT_FILE), { recursive: true })
      writeFileSync(HEARTBEAT_FILE, new Date().toISOString())
    } catch (err) {
      console.error('[scheduler] failed to write heartbeat:', err)
    }
    setTimeout(runTick, 60_000)
  }
}

export const startScheduler = () => {
  // Align first tick to the next whole minute, then every 60s
  const msToNextMinute =
    (60 - new Date().getSeconds()) * 1000 - new Date().getMilliseconds()

  setTimeout(runTick, msToNextMinute)

  console.log(
    `[scheduler] starting, first tick in ${Math.round(msToNextMinute / 1000)}s`
  )
}
