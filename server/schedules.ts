import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import path from 'path'
import {
  getEnrichedGroups,
  getSensors,
  getSwitchSensorIds,
  setGroupAction,
  setLightState,
  activateScene,
  activateSmartScene
} from './hue'

const SCHEDULES_FILE = path.join(process.cwd(), 'data', 'schedules.json')

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

// Tracks, per room, the id of the slot that was active on the previous tick
// (or null when no slot was active). Slot application is edge-triggered off
// this — only when the active slot id changes do we recall a scene — so a
// slot that's been active for many ticks in a row is left alone instead of
// being re-recalled every minute, which was what caused manually-off lights
// to flicker on and back off each tick.
const lastActiveSlot = new Map<string, string | null>()

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

// Applies a scene slot, then restores pre-scene off-state to any light that
// was off beforehand — a group scene recall otherwise turns every light in
// the room back on, including ones the user just switched off by hand.
// `respectManualOff` is false for rooms with no linked wall switch (see
// `getSwitchSensorIds`), since a breaker-only room's "off" bridge state can't
// be trusted as a deliberate override — there's no switch to press, and
// flipping the breaker back on doesn't restore the bridge's own on-flag.
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
  const nowMin = now.getHours() * 60 + now.getMinutes()

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
      if (schedule.killSwitch) {
        if (group?.state.any_on) {
          await setGroupAction(schedule.groupId, { on: false })
        }
        continue
      }

      if (schedule.autoOff?.enabled && group) {
        const turnedOff = await applyAutoOff(
          schedule,
          group,
          sensors,
          now.getTime()
        )
        if (turnedOff) continue
      }

      if (schedule.enabled && schedule.slots.length) {
        const slot = schedule.slots.find((s) => inSlot(nowMin, s))

        const prevSlotId = lastActiveSlot.get(schedule.groupId) ?? null
        const currSlotId = slot?.id ?? null
        const enteringSlot = currSlotId !== prevSlotId
        lastActiveSlot.set(schedule.groupId, currSlotId)

        if (slot) {
          if (slot.sceneType === 'off') {
            await setGroupAction(schedule.groupId, { on: false })
          } else if (group && enteringSlot) {
            const hasLinkedSwitch =
              switchCoverage?.get(schedule.groupId) ?? false
            await applySceneSlot(schedule.groupId, slot, group, hasLinkedSwitch)
          }
        }
      }
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
