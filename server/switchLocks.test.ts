import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import hue = require('./hue')
import { syncSwitchLocks } from './switchLocks'
import type { SwitchBehavior, SwitchBehaviorConfig } from './hue'

// Scenario coverage for locking a killed or scheduled room's physical
// switches: what gets silenced, what gets restored, and what survives a Hue
// app edit or a half-failed sync. The bridge is an in-memory map of behavior instances.

const mutableHue = hue as unknown as Record<string, unknown>

let bridge: Map<string, SwitchBehavior>
let writes: string[]
let fetches: number
let failWritesFor: Set<string>
let file: string

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v))

beforeEach(() => {
  bridge = new Map()
  writes = []
  fetches = 0
  failWritesFor = new Set()
  file = path.join(mkdtempSync(path.join(tmpdir(), 'switch-locks-')), 'locks.json')
  mutableHue.getRoomIdMap = async () => ({
    '1': 'room-nere',
    '3': 'room-kontoret',
    '82': 'room-lekrummet'
  })
  mutableHue.getSceneIdMap = async () => ({
    'v1-evening': 'scene-evening',
    'v1-night': 'scene-night'
  })
  mutableHue.getButtonControlIds = async () => controlIds
  mutableHue.getSwitchBehaviors = async () => {
    fetches++
    return [...bridge.values()].map(clone)
  }
  mutableHue.setSwitchBehaviorConfiguration = async (
    id: string,
    configuration: SwitchBehaviorConfig
  ) => {
    if (failWritesFor.has(id)) throw new Error('bridge timeout')
    writes.push(id)
    bridge.get(id)!.configuration = clone(configuration)
    return {}
  }
})

const none = { silenced: [], pinned: {} }
const killed = (...ids: string[]) => ({ silenced: ids, pinned: {} })
const scheduled = (groupId: string, sceneId: string, sceneType: 'static' | 'smart' = 'static') => ({
  silenced: [],
  pinned: { [groupId]: { sceneId, sceneType } }
})

const where = (rid: string) => [{ group: { rid, rtype: 'room' } }]

const recall = (rid: string, rtype = 'scene') => ({ action: { recall: { rid, rtype } } })

// Shaped like the real RWL022 dimmer config: a "time based light" power
// button with smart on/off, a hue button, both with press/long-press
// handlers, and dim buttons with a repeat handler only.
const dimmer = (id: string, rooms: [string, string, string, string]): SwitchBehavior => ({
  id,
  name: `Dimmer ${id}`,
  configuration: {
    buttons: {
      on: {
        on_short_release: {
          time_based_extended: {
            repeat_timeout: { seconds: 3 },
            slots: [
              { actions: [recall('scene-bright')], start_time: { hour: 7, minute: 0 } },
              { actions: [recall('scene-evening')], start_time: { hour: 19, minute: 0 } }
            ],
            with_off: { enabled: true }
          }
        },
        on_long_press: { action: 'do_nothing' },
        where: where(rooms[0])
      },
      up: { on_repeat: { action: 'dim_up' }, where: where(rooms[1]) },
      down: { on_repeat: { action: 'dim_down' }, where: where(rooms[2]) },
      hue: {
        on_short_release: { scene_cycle_extended: { slots: [] } },
        on_long_press: { action: 'do_nothing' },
        where: where(rooms[3])
      }
    },
    device: { rid: `device-${id}`, rtype: 'device' },
    model_id: 'RWL022'
  }
})

// Every dimmer() uses the same button ids; on the bridge they're per-switch
// UUIDs, but only the control_id matters here.
const controlIds: Record<string, number> = { on: 1, up: 2, down: 3, hue: 4 }

const add = (behavior: SwitchBehavior) => {
  bridge.set(behavior.id, clone(behavior))
  return behavior
}

const isSilenced = (button: Record<string, unknown>) =>
  Object.entries(button).every(
    ([k, v]) => k === 'where' || (v as { action?: string }).action === 'do_nothing'
  )

test('killing a room silences only the buttons bound to it, and releasing restores the switch exactly', async () => {
  const shared = add(
    dimmer('shared', ['room-nere', 'room-nere', 'room-kontoret', 'room-kontoret'])
  )
  const other = add(
    dimmer('other', ['room-kontoret', 'room-kontoret', 'room-kontoret', 'room-kontoret'])
  )

  await syncSwitchLocks(killed('1'), file)

  const locked = bridge.get('shared')!.configuration.buttons
  assert.ok(isSilenced(locked.on) && isSilenced(locked.up))
  assert.deepEqual(locked.down, shared.configuration.buttons.down)
  assert.deepEqual(locked.hue, shared.configuration.buttons.hue)
  assert.deepEqual(bridge.get('other'), other)

  await syncSwitchLocks(none, file)

  assert.deepEqual(bridge.get('shared'), shared)
  assert.deepEqual(bridge.get('other'), other)
})

test('a killed room with no switch leaves every switch untouched', async () => {
  add(dimmer('nere', ['room-nere', 'room-nere', 'room-nere', 'room-nere']))

  await syncSwitchLocks(killed('82'), file)
  await syncSwitchLocks(none, file)

  assert.deepEqual(writes, [])
})

test('an unchanged set of killed rooms does not touch the bridge again', async () => {
  add(dimmer('nere', ['room-nere', 'room-nere', 'room-nere', 'room-nere']))

  await syncSwitchLocks(killed('1'), file)
  const fetchesAfterLock = fetches
  await syncSwitchLocks(killed('1'), file)

  assert.equal(fetches, fetchesAfterLock)
})

test('a switch reconfigured in the Hue app while locked keeps that configuration on release', async () => {
  add(dimmer('nere', ['room-nere', 'room-nere', 'room-nere', 'room-nere']))
  await syncSwitchLocks(killed('1'), file)

  const edited = dimmer('nere', ['room-kontoret', 'room-kontoret', 'room-kontoret', 'room-kontoret'])
  bridge.set('nere', clone(edited))
  await syncSwitchLocks(none, file)

  assert.deepEqual(bridge.get('nere'), edited)
})

test('a lock that failed halfway is retried without losing the already-locked switch\'s original', async () => {
  const a = add(dimmer('a', ['room-nere', 'room-nere', 'room-nere', 'room-nere']))
  const b = add(dimmer('b', ['room-nere', 'room-nere', 'room-nere', 'room-nere']))

  failWritesFor.add('b')
  await assert.rejects(syncSwitchLocks(killed('1'), file))
  failWritesFor.clear()
  await syncSwitchLocks(killed('1'), file)

  assert.ok(isSilenced(bridge.get('b')!.configuration.buttons.on))

  await syncSwitchLocks(none, file)

  assert.deepEqual(bridge.get('a'), a)
  assert.deepEqual(bridge.get('b'), b)
})

const pinnedTo = (button: Record<string, unknown>) => {
  const tbe = (button.on_short_release as {
    time_based_extended: { slots: Array<{ actions: unknown[] }>; with_off: unknown }
  }).time_based_extended
  return {
    actions: tbe.slots.map((slot) => slot.actions),
    withOff: tbe.with_off,
    longPress: button.on_long_press
  }
}

test('a scheduled room\'s power button recalls only the slot\'s scene, the rest is silenced, and the schedule ending restores the switch exactly', async () => {
  const nere = add(dimmer('nere', ['room-nere', 'room-nere', 'room-nere', 'room-nere']))

  await syncSwitchLocks(scheduled('1', 'v1-evening'), file)

  const locked = bridge.get('nere')!.configuration.buttons
  assert.deepEqual(pinnedTo(locked.on), {
    actions: [[recall('scene-evening')]],
    withOff: { enabled: true },
    longPress: { action: 'do_nothing' }
  })
  assert.ok(isSilenced(locked.up) && isSilenced(locked.down) && isSilenced(locked.hue))

  await syncSwitchLocks(none, file)

  assert.deepEqual(bridge.get('nere'), nere)
})

test('moving to a slot with another scene re-pins the power button, and the original still comes back afterwards', async () => {
  const nere = add(dimmer('nere', ['room-nere', 'room-nere', 'room-nere', 'room-nere']))

  await syncSwitchLocks(scheduled('1', 'v1-evening'), file)
  await syncSwitchLocks(scheduled('1', 'v1-night'), file)

  assert.deepEqual(pinnedTo(bridge.get('nere')!.configuration.buttons.on).actions, [
    [recall('scene-night')]
  ])

  await syncSwitchLocks(none, file)

  assert.deepEqual(bridge.get('nere'), nere)
})

test('a smart scene slot pins the power button to the smart scene itself', async () => {
  add(dimmer('nere', ['room-nere', 'room-nere', 'room-nere', 'room-nere']))

  await syncSwitchLocks(scheduled('1', 'smart-natural', 'smart'), file)

  assert.deepEqual(pinnedTo(bridge.get('nere')!.configuration.buttons.on).actions, [
    [recall('smart-natural', 'smart_scene')]
  ])
})

test('a slot whose scene is missing from the bridge silences the power button rather than leaving every scene reachable', async () => {
  add(dimmer('nere', ['room-nere', 'room-nere', 'room-nere', 'room-nere']))

  await syncSwitchLocks(scheduled('1', 'v1-deleted'), file)

  assert.ok(isSilenced(bridge.get('nere')!.configuration.buttons.on))
})

test('killing a scheduled room silences its power button too, and releasing the kill switch mid-slot gives back only the pinned power button', async () => {
  const nere = add(dimmer('nere', ['room-nere', 'room-nere', 'room-nere', 'room-nere']))

  await syncSwitchLocks(scheduled('1', 'v1-evening'), file)
  await syncSwitchLocks({ ...scheduled('1', 'v1-evening'), silenced: ['1'] }, file)

  assert.ok(isSilenced(bridge.get('nere')!.configuration.buttons.on))

  await syncSwitchLocks(scheduled('1', 'v1-evening'), file)

  const locked = bridge.get('nere')!.configuration.buttons
  assert.deepEqual(pinnedTo(locked.on).actions, [[recall('scene-evening')]])
  assert.ok(isSilenced(locked.up))

  await syncSwitchLocks(none, file)

  assert.deepEqual(bridge.get('nere'), nere)
})
