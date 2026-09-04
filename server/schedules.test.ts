import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import hue = require('./hue')
import { processSchedule } from './schedules'
import type { RoomSchedule, TimeSlot } from './schedules'
import type { EnrichedGroup, Light, LightState, SceneLightState } from './hue'

// Scenario coverage for processSchedule() -- the per-room decision made each
// tick. Deliberately scoped to behavior, not implementation: what a room
// with a kill switch, a linked wall switch, a breaker-only setup, a drifted
// scene, or a smart scene should do, not every branch of the function.

interface Call {
  fn: string
  args: unknown[]
}
let calls: Call[] = []
let sceneLightstates: Record<string, Record<string, SceneLightState>> = {}
let smartSceneLightstates: Record<string, Record<string, SceneLightState>> = {}

const record =
  (fn: string) =>
  (...args: unknown[]) => {
    calls.push({ fn, args })
    return Promise.resolve({})
  }

// `hue`'s exports are `export const`, which TS treats as read-only even via
// `import ... = require(...)` -- this file mocks the bridge boundary by
// mutating the shared CJS module object directly, so the cast is deliberate.
const mutableHue = hue as unknown as Record<string, unknown>

beforeEach(() => {
  calls = []
  sceneLightstates = {}
  smartSceneLightstates = {}
  mutableHue.setGroupAction = record('setGroupAction')
  mutableHue.activateScene = record('activateScene')
  mutableHue.activateSmartScene = record('activateSmartScene')
  mutableHue.setLightState = record('setLightState')
  mutableHue.getSceneLightstates = async (sceneId: string) =>
    sceneLightstates[sceneId] ?? {}
  mutableHue.getSmartSceneTargetLightstates = async (sceneId: string) =>
    smartSceneLightstates[sceneId] ?? {}
})

const callsFor = (fn: string) => calls.filter((c) => c.fn === fn)

const light = (
  id: string,
  state: LightState = { on: true, bri: 200, ct: 350, reachable: true },
  capabilities?: Light['capabilities']
): Light => ({
  id,
  name: `Light ${id}`,
  type: 'Color temperature light',
  manufacturername: '',
  productname: '',
  modelid: '',
  state,
  capabilities
})

const group = (id: string, lights: Light[]): EnrichedGroup => ({
  id,
  name: `Room ${id}`,
  type: 'Room',
  class: 'Other',
  lights: lights.map((l) => l.id),
  sensors: [],
  state: {
    all_on: lights.every((l) => l.state.on),
    any_on: lights.some((l) => l.state.on)
  },
  action: {},
  lightDetails: lights
})

const schedule = (
  groupId: string,
  overrides: Partial<RoomSchedule> = {}
): RoomSchedule => ({
  groupId,
  enabled: true,
  slots: [],
  ...overrides
})

// Spans the whole day so every test is independent of the machine's clock.
const allDaySlot = (
  groupId: string,
  sceneType: TimeSlot['sceneType'] = 'static'
): TimeSlot => ({
  id: `${groupId}-slot`,
  startTime: '00:00',
  endTime: '23:59',
  sceneId: `${groupId}-scene`,
  sceneType
})

test('kill switch forces the room off, ignoring any active slot', async () => {
  const groupId = 'kill-on'
  const g = group(groupId, [light('1')])
  const s = schedule(groupId, { killSwitch: true, slots: [allDaySlot(groupId)] })

  await processSchedule(s, g, null, null, new Date())

  assert.deepEqual(
    callsFor('setGroupAction').map((c) => c.args),
    [[groupId, { on: false }]]
  )
  assert.equal(callsFor('activateScene').length, 0)
})

test('kill switch does not resend an off command to an already-off room', async () => {
  const groupId = 'kill-off'
  const g = group(groupId, [light('1', { on: false, reachable: true })])
  const s = schedule(groupId, { killSwitch: true })

  await processSchedule(s, g, null, null, new Date())

  assert.equal(callsFor('setGroupAction').length, 0)
})

test('an "off" slot turns the room off via a group action, not a scene', async () => {
  const groupId = 'off-slot'
  const g = group(groupId, [light('1')])
  const s = schedule(groupId, { slots: [allDaySlot(groupId, 'off')] })

  await processSchedule(s, g, null, null, new Date())

  assert.deepEqual(
    callsFor('setGroupAction').map((c) => c.args),
    [[groupId, { on: false }]]
  )
  assert.equal(callsFor('activateScene').length, 0)
})

test('entering a new slot applies its scene', async () => {
  const groupId = 'enter'
  const g = group(groupId, [light('1')])
  const s = schedule(groupId, { slots: [allDaySlot(groupId)] })

  await processSchedule(s, g, null, null, new Date())

  assert.deepEqual(
    callsFor('activateScene').map((c) => c.args),
    [[groupId, `${groupId}-scene`]]
  )
})

test('a fully manually-off room with a linked switch is left off, not forced on', async () => {
  const groupId = 'room-off'
  const g = group(groupId, [light('1', { on: false, reachable: true })])
  const s = schedule(groupId, { slots: [allDaySlot(groupId)] })
  const switchCoverage = new Map([[groupId, true]])

  await processSchedule(s, g, null, switchCoverage, new Date())

  assert.equal(callsFor('activateScene').length, 0)
  assert.equal(callsFor('setGroupAction').length, 0)
})

test('a partially manually-off room with a linked switch: the scene applies, then the off light goes back off', async () => {
  const groupId = 'light-off'
  const onLight = light('1')
  const offLight = light('2', { on: false, reachable: true })
  const g = group(groupId, [onLight, offLight])
  const s = schedule(groupId, { slots: [allDaySlot(groupId)] })
  const switchCoverage = new Map([[groupId, true]])

  await processSchedule(s, g, null, switchCoverage, new Date())

  assert.equal(callsFor('activateScene').length, 1)
  assert.deepEqual(
    callsFor('setLightState').map((c) => c.args),
    [['2', { on: false }]]
  )
})

test('a manually-off room with no linked switch (breaker-only) still gets the scene forced on', async () => {
  const groupId = 'no-switch'
  const g = group(groupId, [light('1', { on: false, reachable: true })])
  const s = schedule(groupId, { slots: [allDaySlot(groupId)] })

  await processSchedule(s, g, null, new Map(), new Date())

  assert.equal(callsFor('activateScene').length, 1)
})

test('a missed group lookup leaves the slot unlatched so the next tick retries', async () => {
  const groupId = 'retry'
  const s = schedule(groupId, { slots: [allDaySlot(groupId)] })
  const now = new Date()

  await processSchedule(s, undefined, null, null, now)
  assert.equal(callsFor('activateScene').length, 0)

  const g = group(groupId, [light('1')])
  await processSchedule(s, g, null, null, now)
  assert.equal(callsFor('activateScene').length, 1)
})

test('a static scene that has drifted mid-slot is corrected on the next tick', async () => {
  const groupId = 'drift-apply'
  const slot = allDaySlot(groupId)
  const s = schedule(groupId, { slots: [slot] })
  const now = new Date()
  sceneLightstates[slot.sceneId] = { '1': { on: true, bri: 254, ct: 346 } }

  const matching = group(groupId, [light('1', { on: true, bri: 254, ct: 346, reachable: true })])
  await processSchedule(s, matching, null, null, now)
  assert.equal(callsFor('activateScene').length, 1)

  const drifted = group(groupId, [light('1', { on: true, bri: 77, ct: 366, reachable: true })])
  await processSchedule(s, drifted, null, null, now)
  assert.equal(callsFor('activateScene').length, 2)
})

test('a static scene that still matches is left untouched on later ticks', async () => {
  const groupId = 'drift-noop'
  const slot = allDaySlot(groupId)
  const s = schedule(groupId, { slots: [slot] })
  const now = new Date()
  sceneLightstates[slot.sceneId] = { '1': { on: true, bri: 254, ct: 346 } }

  const g = group(groupId, [light('1', { on: true, bri: 254, ct: 346, reachable: true })])
  await processSchedule(s, g, null, null, now)
  assert.equal(callsFor('activateScene').length, 1)

  await processSchedule(s, g, null, null, now)
  assert.equal(callsFor('activateScene').length, 1)
})

test('a manually-off light does not count as drift, so it is not flicked back on to fix it', async () => {
  const groupId = 'drift-manual-off'
  const slot = allDaySlot(groupId)
  const s = schedule(groupId, { slots: [slot] })
  const now = new Date()
  const switchCoverage = new Map([[groupId, true]])
  sceneLightstates[slot.sceneId] = {
    '1': { on: true, bri: 254, ct: 346 },
    '2': { on: true, bri: 254, ct: 346 }
  }

  const bothOn = group(groupId, [
    light('1', { on: true, bri: 254, ct: 346, reachable: true }),
    light('2', { on: true, bri: 254, ct: 346, reachable: true })
  ])
  await processSchedule(s, bothOn, null, switchCoverage, now)
  assert.equal(callsFor('activateScene').length, 1)

  const oneManuallyOff = group(groupId, [
    light('1', { on: true, bri: 254, ct: 346, reachable: true }),
    light('2', { on: false, bri: 1, ct: 346, reachable: true })
  ])
  await processSchedule(s, oneManuallyOff, null, switchCoverage, now)
  assert.equal(callsFor('activateScene').length, 1)
})

test('crossing into a new slot that shares the previous slot\'s scene does not re-flicker a manually-off light', async () => {
  const groupId = 'same-scene-boundary'
  const eveningSlot: TimeSlot = {
    id: 'evening',
    startTime: '21:00',
    endTime: '23:55',
    sceneId: 'nightlight',
    sceneType: 'static'
  }
  const predawnSlot: TimeSlot = {
    id: 'predawn',
    startTime: '00:00',
    endTime: '06:00',
    sceneId: 'nightlight',
    sceneType: 'static'
  }
  const s = schedule(groupId, { slots: [eveningSlot, predawnSlot] })
  const switchCoverage = new Map([[groupId, true]])
  sceneLightstates['nightlight'] = {
    '1': { on: true, bri: 1, ct: 500 },
    '2': { on: true, bri: 1, ct: 500 }
  }

  const g = group(groupId, [
    light('1', { on: true, bri: 1, ct: 500, reachable: true }),
    light('2', { on: false, bri: 1, ct: 500, reachable: true })
  ])

  // 22:00: entering the evening slot applies the scene once; light '2' was
  // already manually off, so it gets the one expected on/off restore cycle.
  await processSchedule(
    s,
    g,
    null,
    switchCoverage,
    new Date(2026, 0, 1, 22, 0)
  )
  assert.equal(callsFor('activateScene').length, 1)
  assert.equal(callsFor('setLightState').length, 1)

  // 00:30: crosses into the pre-dawn slot, but it's the exact same scene --
  // must not re-trigger a scene recall (which would flicker light '2' on
  // again).
  await processSchedule(
    s,
    g,
    null,
    switchCoverage,
    new Date(2026, 0, 1, 0, 30)
  )
  assert.equal(callsFor('activateScene').length, 1)
  assert.equal(callsFor('setLightState').length, 1)
})

test('a light whose hardware ct range falls short of the scene target is not treated as permanent drift', async () => {
  const groupId = 'ct-capped'
  const slot = allDaySlot(groupId)
  const s = schedule(groupId, { slots: [slot] })
  const now = new Date()
  const switchCoverage = new Map([[groupId, true]])
  sceneLightstates[slot.sceneId] = {
    '1': { on: true, bri: 1, ct: 500 },
    '2': { on: true, bri: 1, ct: 500 }
  }

  // Light '1' can only reach ct 454 in hardware -- the bridge clamps any
  // request past that and reports the clamped value back, forever short of
  // the scene's stored target of 500.
  const cappedLight = light(
    '1',
    { on: true, bri: 1, ct: 454, reachable: true },
    { control: { ct: { min: 250, max: 454 } } }
  )
  const manuallyOffLight = light('2', { on: false, bri: 1, ct: 500, reachable: true })
  const g = group(groupId, [cappedLight, manuallyOffLight])

  // Entering the slot applies the scene once, restoring the manually-off
  // light per the usual single-tick flicker.
  await processSchedule(s, g, null, switchCoverage, now)
  assert.equal(callsFor('activateScene').length, 1)
  assert.equal(callsFor('setLightState').length, 1)

  // A later tick, still mid-slot: light '1' is exactly as clamped and
  // therefore not drifted, so this must not re-trigger a scene recall (which
  // would flicker light '2' on again).
  await processSchedule(s, g, null, switchCoverage, now)
  assert.equal(callsFor('activateScene').length, 1)
  assert.equal(callsFor('setLightState').length, 1)
})

test('a smart scene is only activated on entry, never reapplied mid-slot', async () => {
  const groupId = 'smart'
  const s = schedule(groupId, { slots: [allDaySlot(groupId, 'smart')] })
  const now = new Date()
  const g = group(groupId, [light('1')])

  await processSchedule(s, g, null, null, now)
  assert.equal(callsFor('activateSmartScene').length, 1)

  await processSchedule(s, g, null, null, now)
  assert.equal(callsFor('activateSmartScene').length, 1)
})

test('a smart scene light that has not caught up yet is nudged directly (not re-activated) until it converges', async () => {
  const groupId = 'smart-converge'
  const slot = allDaySlot(groupId, 'smart')
  const s = schedule(groupId, { slots: [slot] })
  const now = new Date()
  smartSceneLightstates[slot.sceneId] = { '1': { on: true, bri: 254, ct: 156 } }

  // Entering the slot activates the smart scene once; the light hasn't
  // caught up to the new target yet (still at the previous scene's values).
  const lagging = group(groupId, [
    light('1', { on: true, bri: 1, ct: 250, reachable: true })
  ])
  await processSchedule(s, lagging, null, null, now)
  assert.equal(callsFor('activateSmartScene').length, 1)
  assert.equal(callsFor('setLightState').length, 0)

  // Next tick, still lagging: nudged directly via setLightState rather than
  // re-activating the smart scene, which would restart its own cycling.
  await processSchedule(s, lagging, null, null, now)
  assert.equal(callsFor('activateSmartScene').length, 1)
  assert.deepEqual(callsFor('setLightState').map((c) => c.args), [
    ['1', { on: true, bri: 254, ct: 156 }]
  ])

  // Once the light actually reaches the target, it's left alone.
  const caughtUp = group(groupId, [
    light('1', { on: true, bri: 254, ct: 156, reachable: true })
  ])
  await processSchedule(s, caughtUp, null, null, now)
  assert.equal(callsFor('setLightState').length, 1)
  assert.equal(callsFor('activateSmartScene').length, 1)
})

test('a smart scene light that never converges stops being nudged after a bounded number of ticks', async () => {
  const groupId = 'smart-stuck'
  const slot = allDaySlot(groupId, 'smart')
  const s = schedule(groupId, { slots: [slot] })
  const now = new Date()
  smartSceneLightstates[slot.sceneId] = { '1': { on: true, bri: 254, ct: 156 } }
  const stuck = group(groupId, [
    light('1', { on: true, bri: 1, ct: 250, reachable: true })
  ])

  await processSchedule(s, stuck, null, null, now) // entry: activates once
  for (let i = 0; i < 10; i++) {
    await processSchedule(s, stuck, null, null, now)
  }

  assert.equal(callsFor('activateSmartScene').length, 1)
  const nudgesWhileGivingUp = callsFor('setLightState').length
  assert.ok(
    nudgesWhileGivingUp > 0 && nudgesWhileGivingUp < 10,
    `expected a bounded number of nudges before giving up, got ${nudgesWhileGivingUp}`
  )

  // Further ticks must not resume nudging once it's given up.
  await processSchedule(s, stuck, null, null, now)
  assert.equal(callsFor('setLightState').length, nudgesWhileGivingUp)
})

test('a manually-off light is not nudged while a smart scene is converging', async () => {
  const groupId = 'smart-manual-off'
  const slot = allDaySlot(groupId, 'smart')
  const s = schedule(groupId, { slots: [slot] })
  const now = new Date()
  const switchCoverage = new Map([[groupId, true]])
  smartSceneLightstates[slot.sceneId] = {
    '1': { on: true, bri: 254, ct: 156 },
    '2': { on: true, bri: 254, ct: 156 }
  }

  const g = group(groupId, [
    light('1', { on: true, bri: 1, ct: 250, reachable: true }),
    light('2', { on: false, bri: 1, ct: 250, reachable: true })
  ])

  // Entry activates the scene and restores light '2' (manually off) back
  // off, per the usual single-tick flicker -- unrelated to convergence.
  await processSchedule(s, g, null, switchCoverage, now)
  assert.deepEqual(callsFor('setLightState').map((c) => c.args), [
    ['2', { on: false }]
  ])

  // Convergence tick: light '1' hasn't caught up and gets nudged; light '2'
  // is legitimately off (respected, since the room has a linked switch) and
  // must not be nudged back on to "fix" it.
  await processSchedule(s, g, null, switchCoverage, now)
  assert.deepEqual(callsFor('setLightState').map((c) => c.args), [
    ['2', { on: false }],
    ['1', { on: true, bri: 254, ct: 156 }]
  ])
})
