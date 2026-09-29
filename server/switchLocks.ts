import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import path from 'path'
import {
  getButtonControlIds,
  getRoomIdMap,
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
// preservation.
//
// The originals live in their own file rather than in schedules.json because
// a client schedule save replaces a room's whole entry, and losing an
// original would leave the switch dead with nothing to restore it from.
const DEFAULT_FILE = path.join(process.cwd(), 'data', 'switch-locks.json')

// v1 group ids per lock mode. A room in both is treated as killed.
export interface LockedRooms {
  killed: string[]
  powerOnly: string[]
}

interface LockState extends LockedRooms {
  // behavior instance id → configuration as it was before any lock
  originals: Record<string, SwitchBehaviorConfig>
}

// The RWL022 dimmer's power button (toggles on/off) is control_id 1.
// Older dimmers (RWL020/021) have a separate off button at 4, which a
// power-only lock would silence.
const POWER_BUTTON_CONTROL_ID = 1

const load = (file: string): LockState => {
  if (!existsSync(file)) return { killed: [], powerOnly: [], originals: {} }
  // Deliberately no catch: treating a corrupt file as empty would drop the
  // originals and make every locked switch's lock permanent.
  const raw = JSON.parse(readFileSync(file, 'utf8'))
  // Files from before power-only locks have `groups` instead; defaulting to
  // no rooms just makes the next sync reconcile once.
  return {
    killed: raw.killed ?? [],
    powerOnly: raw.powerOnly ?? [],
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

const neutralize = (
  config: SwitchBehaviorConfig,
  killedRoomIds: Set<string>,
  powerOnlyRoomIds: Set<string>,
  powerButtonIds: Set<string>
): SwitchBehaviorConfig => {
  const boundTo = (button: SwitchButtonConfig, roomIds: Set<string>) =>
    !!button.where?.some((w) => w.group && roomIds.has(w.group.rid))
  return {
    ...config,
    buttons: Object.fromEntries(
      Object.entries(config.buttons).map(([id, button]) => [
        id,
        boundTo(button, killedRoomIds) ||
        (boundTo(button, powerOnlyRoomIds) && !powerButtonIds.has(id))
          ? neutralizeButton(button)
          : button
      ])
    )
  }
}

// True if `current` is `original` with zero or more buttons neutralized --
// i.e. nothing but this module has touched it. Anything else means it was
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
      same(currentButtons[id], neutralizeButton(button))
  )
}

const reconcile = async (rooms: LockedRooms, file: string) => {
  const state = load(file)
  const killed = [...new Set(rooms.killed)].sort()
  const powerOnly = [...new Set(rooms.powerOnly)]
    .filter((id) => !killed.includes(id))
    .sort()
  if (same(state.killed, killed) && same(state.powerOnly, powerOnly)) return

  const [roomIds, behaviors, controlIds] = await Promise.all([
    getRoomIdMap(),
    getSwitchBehaviors(),
    getButtonControlIds()
  ])
  const toRoomIds = (ids: string[]) =>
    new Set(ids.map((id) => roomIds[id]).filter(Boolean))
  const killedRoomIds = toRoomIds(killed)
  const powerOnlyRoomIds = toRoomIds(powerOnly)
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

    const desired = neutralize(
      original,
      killedRoomIds,
      powerOnlyRoomIds,
      powerButtonIds
    )
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

  state.killed = killed
  state.powerOnly = powerOnly
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
