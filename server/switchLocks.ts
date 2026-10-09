import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import path from 'path'
import {
  getButtonControlIds,
  getRoomIdMap,
  getSceneIdMap,
  getSwitchBehaviors,
  setSwitchBehaviorConfiguration,
  SwitchBehaviorConfig,
  SwitchButtonConfig
} from './hue'

// A kill switch alone only wins once a minute: in between, anyone can press
// the room's dimmer and the lights come straight back on until the next tick.
// So while a room is killed, every switch button bound to it is rewritten to
// do nothing, and the original configuration is written back on release.
//
// A room with a schedule slot running has the same problem in a milder
// form: dimming it by hand gets undone on the next tick's drift correction,
// so the lights bounce between the two. Its switches are cut down to just
// the power button, which the scheduler already accommodates via manual-off
// preservation, and that button is pinned to the slot's scene. The Hue
// app's "time based light" power button with smart on/off steps to the next
// time slot's scene on each repeat press within its timeout, which was
// confirmed live as a way back to full brightness mid-slot.
//
// The originals live in their own file rather than in schedules.json because
// a client schedule save replaces a room's whole entry, and losing an
// original would leave the switch dead with nothing to restore it from.
const DEFAULT_FILE = path.join(process.cwd(), 'data', 'switch-locks.json')

// The scene a scheduled room's power button is pinned to, as the schedule
// slot stores it: a v1 scene id for static scenes, a v2 id for smart ones.
export interface PinnedScene {
  sceneId: string
  sceneType: 'static' | 'smart'
}

// Keyed by v1 group id. A room in both is treated as silenced.
export interface LockedRooms {
  silenced: string[]
  pinned: Record<string, PinnedScene>
}

interface Recall {
  rid: string
  rtype: 'scene' | 'smart_scene'
}

interface LockState extends LockedRooms {
  // behavior instance id → configuration as it was before any lock
  originals: Record<string, SwitchBehaviorConfig>
}

// The RWL022 dimmer's power button (toggles on/off) is control_id 1.
// Older dimmers (RWL020/021) have a separate off button at 4, which a
// scheduled room's lock would silence.
const POWER_BUTTON_CONTROL_ID = 1

const load = (file: string): LockState => {
  if (!existsSync(file)) return { silenced: [], pinned: {}, originals: {} }
  // Deliberately no catch: treating a corrupt file as empty would drop the
  // originals and make every locked switch's lock permanent.
  const raw = JSON.parse(readFileSync(file, 'utf8'))
  // Older files have `groups` or `killed`/`powerOnly` instead; defaulting
  // to no rooms just makes the next sync reconcile once.
  return {
    silenced: raw.silenced ?? [],
    pinned: raw.pinned ?? {},
    originals: raw.originals ?? {}
  }
}

const persist = (file: string, state: LockState) => {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(state, null, 2))
}

// Key order in what the bridge returns isn't guaranteed to match what was
// written, so configs are compared by content.
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        )
      : v
  )

const same = (a: unknown, b: unknown) => canonical(a) === canonical(b)

// The script's schema only accepts certain handler combinations per button
// (e.g. `on_short_release` + `on_long_press`, or `on_repeat` alone), so each
// handler key is kept and only its action is swapped out.
const neutralizeButton = (button: SwitchButtonConfig): SwitchButtonConfig =>
  Object.fromEntries(
    Object.entries(button).map(([key, value]) => [
      key,
      key === 'where' ? value : { action: 'do_nothing' }
    ])
  )

interface TimeBasedSlot {
  actions?: Array<{ action?: { recall?: Recall } }>
}

const recallOf = (button: SwitchButtonConfig | undefined): Recall | undefined =>
  (
    button?.on_short_release as
      | { time_based_extended?: { slots?: TimeBasedSlot[] } }
      | undefined
  )?.time_based_extended?.slots?.[0]?.actions?.[0]?.action?.recall

// The power button keeps its smart on/off (pressing it while the room is on
// turns it off), but with a single slot there's no next scene to step to.
// Any other handler on it (long press) is silenced. A power button with no
// short-press handler, or a scene missing from the bridge, can't be pinned
// and is silenced instead.
const pinButton = (
  button: SwitchButtonConfig,
  recall: Recall | undefined
): SwitchButtonConfig => {
  const shortRelease = button.on_short_release as
    | { time_based_extended?: Record<string, unknown> }
    | undefined
  if (!shortRelease || !recall) return neutralizeButton(button)
  return {
    ...neutralizeButton(button),
    on_short_release: {
      time_based_extended: {
        with_off: { enabled: true },
        ...shortRelease.time_based_extended,
        slots: [
          {
            actions: [{ action: { recall } }],
            start_time: { hour: 0, minute: 0 }
          }
        ]
      }
    }
  }
}

const lock = (
  config: SwitchBehaviorConfig,
  silencedRoomIds: Set<string>,
  pinnedRecalls: Map<string, Recall | undefined>,
  powerButtonIds: Set<string>
): SwitchBehaviorConfig => {
  const roomsOf = (button: SwitchButtonConfig) =>
    (button.where ?? []).flatMap((w) => (w.group ? [w.group.rid] : []))
  return {
    ...config,
    buttons: Object.fromEntries(
      Object.entries(config.buttons).map(([id, button]) => {
        const rooms = roomsOf(button)
        if (rooms.some((r) => silencedRoomIds.has(r))) {
          return [id, neutralizeButton(button)]
        }
        const pinnedRoom = rooms.find((r) => pinnedRecalls.has(r))
        if (!pinnedRoom) return [id, button]
        return [
          id,
          powerButtonIds.has(id)
            ? pinButton(button, pinnedRecalls.get(pinnedRoom))
            : neutralizeButton(button)
        ]
      })
    )
  }
}

// True if `current` is `original` with zero or more buttons neutralized or
// pinned -- i.e. nothing but this module has touched it. Anything else means it was
// reconfigured in the Hue app while locked, and that newer configuration
// wins over the saved one. Deliberately independent of which rooms were
// locked last time, so a sync that failed halfway can't make a half-applied
// lock look like an app edit.
const isLockOf = (
  current: SwitchBehaviorConfig,
  original: SwitchBehaviorConfig
): boolean => {
  const { buttons: currentButtons, ...currentRest } = current
  const { buttons: originalButtons, ...originalRest } = original
  if (!same(currentRest, originalRest)) return false
  if (!same(Object.keys(currentButtons).sort(), Object.keys(originalButtons).sort())) {
    return false
  }
  return Object.entries(originalButtons).every(
    ([id, button]) =>
      same(currentButtons[id], button) ||
      same(currentButtons[id], neutralizeButton(button)) ||
      same(currentButtons[id], pinButton(button, recallOf(currentButtons[id])))
  )
}

const reconcile = async (rooms: LockedRooms, file: string) => {
  const state = load(file)
  const silenced = [...new Set(rooms.silenced)].sort()
  const pinned = Object.fromEntries(
    Object.entries(rooms.pinned).filter(([id]) => !silenced.includes(id))
  )
  if (same(state.silenced, silenced) && same(state.pinned, pinned)) return

  const [roomIds, sceneIds, behaviors, controlIds] = await Promise.all([
    getRoomIdMap(),
    getSceneIdMap(),
    getSwitchBehaviors(),
    getButtonControlIds()
  ])
  const silencedRoomIds = new Set(
    silenced.map((id) => roomIds[id]).filter(Boolean)
  )
  const pinnedRecalls = new Map<string, Recall | undefined>()
  for (const [groupId, scene] of Object.entries(pinned)) {
    const room = roomIds[groupId]
    if (!room) continue
    const rid =
      scene.sceneType === 'smart' ? scene.sceneId : sceneIds[scene.sceneId]
    if (!rid) {
      console.warn(
        `[switch-locks] group ${groupId}: scene ${scene.sceneId} not found on the bridge -- silencing its power button instead`
      )
    }
    pinnedRecalls.set(
      room,
      rid
        ? { rid, rtype: scene.sceneType === 'smart' ? 'smart_scene' : 'scene' }
        : undefined
    )
  }
  const powerButtonIds = new Set(
    Object.keys(controlIds).filter(
      (id) => controlIds[id] === POWER_BUTTON_CONTROL_ID
    )
  )

  for (const behavior of behaviors) {
    let original = state.originals[behavior.id]
    if (original && !isLockOf(behavior.configuration, original)) {
      console.warn(
        `[switch-locks] ${behavior.name} was reconfigured in the Hue app while locked -- keeping that configuration`
      )
      original = behavior.configuration
    }
    original ??= behavior.configuration

    const desired = lock(original, silencedRoomIds, pinnedRecalls, powerButtonIds)
    const locked = !same(desired, original)

    // Saved before the bridge write, so a crash in between can't lose it.
    if (locked) {
      state.originals[behavior.id] = original
      persist(file, state)
    }
    if (!same(desired, behavior.configuration)) {
      await setSwitchBehaviorConfiguration(behavior.id, desired)
      console.log(
        `[switch-locks] ${behavior.name}: ${locked ? 'locked' : 'restored'}`
      )
    }
    if (!locked && state.originals[behavior.id]) {
      delete state.originals[behavior.id]
      persist(file, state)
    }
  }

  // A switch removed from the bridge while locked has nothing to restore.
  for (const id of Object.keys(state.originals)) {
    if (!behaviors.some((b) => b.id === id)) delete state.originals[id]
  }

  state.silenced = silenced
  state.pinned = pinned
  persist(file, state)
}

// Serialized so the kill-switch endpoint and a scheduler tick can't both
// read the same state and write conflicting configs.
let queue: Promise<unknown> = Promise.resolve()

export const syncSwitchLocks = (
  rooms: LockedRooms,
  file: string = DEFAULT_FILE
): Promise<void> => {
  const run = queue.then(() => reconcile(rooms, file))
  queue = run.catch(() => {})
  return run
}
