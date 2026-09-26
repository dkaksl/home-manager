import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import hue = require('./hue')
import { syncSwitchLocks } from './switchLocks'
import type { SwitchBehavior, SwitchBehaviorConfig } from './hue'

// Scenario coverage for locking a killed room's physical switches: what gets
// silenced, what gets restored, and what survives a Hue app edit or a
// half-failed sync. The bridge is an in-memory map of behavior instances.

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

const where = (rid: string) => [{ group: { rid, rtype: 'room' } }]

// Shaped like the real RWL022 dimmer config: on/off and hue buttons with
// press/long-press handlers, dim buttons with a repeat handler only.
const dimmer = (id: string, rooms: [string, string, string, string]): SwitchBehavior => ({
  id,
  name: `Dimmer ${id}`,
  configuration: {
    buttons: {
      on: {
        on_short_release: { time_based_extended: { slots: [], with_off: { enabled: true } } },
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

  await syncSwitchLocks(['1'], file)

  const locked = bridge.get('shared')!.configuration.buttons
  assert.ok(isSilenced(locked.on) && isSilenced(locked.up))
  assert.deepEqual(locked.down, shared.configuration.buttons.down)
  assert.deepEqual(locked.hue, shared.configuration.buttons.hue)
  assert.deepEqual(bridge.get('other'), other)

  await syncSwitchLocks([], file)

  assert.deepEqual(bridge.get('shared'), shared)
  assert.deepEqual(bridge.get('other'), other)
})

test('a killed room with no switch leaves every switch untouched', async () => {
  add(dimmer('nere', ['room-nere', 'room-nere', 'room-nere', 'room-nere']))

  await syncSwitchLocks(['82'], file)
  await syncSwitchLocks([], file)

  assert.deepEqual(writes, [])
})

test('an unchanged set of killed rooms does not touch the bridge again', async () => {
  add(dimmer('nere', ['room-nere', 'room-nere', 'room-nere', 'room-nere']))

  await syncSwitchLocks(['1'], file)
  const fetchesAfterLock = fetches
  await syncSwitchLocks(['1'], file)

  assert.equal(fetches, fetchesAfterLock)
})

test('a switch reconfigured in the Hue app while locked keeps that configuration on release', async () => {
  add(dimmer('nere', ['room-nere', 'room-nere', 'room-nere', 'room-nere']))
  await syncSwitchLocks(['1'], file)

  const edited = dimmer('nere', ['room-kontoret', 'room-kontoret', 'room-kontoret', 'room-kontoret'])
  bridge.set('nere', clone(edited))
  await syncSwitchLocks([], file)

  assert.deepEqual(bridge.get('nere'), edited)
})

test('a lock that failed halfway is retried without losing the already-locked switch\'s original', async () => {
  const a = add(dimmer('a', ['room-nere', 'room-nere', 'room-nere', 'room-nere']))
  const b = add(dimmer('b', ['room-nere', 'room-nere', 'room-nere', 'room-nere']))

  failWritesFor.add('b')
  await assert.rejects(syncSwitchLocks(['1'], file))
  failWritesFor.clear()
  await syncSwitchLocks(['1'], file)

  assert.ok(isSilenced(bridge.get('b')!.configuration.buttons.on))

  await syncSwitchLocks([], file)

  assert.deepEqual(bridge.get('a'), a)
  assert.deepEqual(bridge.get('b'), b)
})
