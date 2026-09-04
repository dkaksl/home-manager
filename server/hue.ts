import { Agent } from 'undici'
import { config } from 'dotenv'

config()

const HUE_IP = process.env.HUE_IP || '192.168.1.182'
const HUE_USER = process.env.HUE_USER?.trim() ?? ''

// Guards against a stalled bridge response wedging the scheduler tick
// forever: a fetch with no timeout that never resolves or rejects will
// pile up queued requests behind it on undici's shared connection pool,
// silently blocking every future tick too.
const FETCH_TIMEOUT_MS = 10_000
const withTimeout = () => AbortSignal.timeout(FETCH_TIMEOUT_MS)

export interface LightState {
  on: boolean
  bri?: number
  hue?: number
  sat?: number
  ct?: number
  colormode?: string
  reachable: boolean
  mode?: string
}

// A light's own hardware limits, as reported by the bridge -- e.g. a color-
// temperature bulb whose `ct` range doesn't reach as far as some scenes
// assume. Optional because plenty of lights (and every unit test fixture)
// have no such restriction worth tracking.
export interface LightCapabilities {
  control?: {
    ct?: { min: number; max: number }
  }
}

export interface Light {
  id: string
  name: string
  type: string
  state: LightState
  manufacturername: string
  productname: string
  modelid: string
  capabilities?: LightCapabilities
}

export interface GroupState {
  all_on: boolean
  any_on: boolean
}

export interface Group {
  id: string
  name: string
  type: string
  class: string
  lights: string[]
  sensors: string[]
  state: GroupState
  action: Record<string, unknown>
}

export interface EnrichedGroup extends Group {
  lightDetails: Light[]
}

const getUser = (): string => {
  if (!HUE_USER) throw new Error('HUE_USER_NOT_CONFIGURED')
  return HUE_USER
}

const apiBase = () => `http://${HUE_IP}/api/${getUser()}`

// v2 API (HTTPS, self-signed cert on bridge)
const v2Base = () => `https://${HUE_IP}/clip/v2/resource`
const v2Headers = () => ({ 'hue-application-key': getUser() })
const v2Agent = new Agent({ connect: { rejectUnauthorized: false } })

// The v1 bridge returns [{error:{type:1,...}}] for an invalid user token
const assertAuthOk = (json: unknown) => {
  if (Array.isArray(json) && json[0]?.error?.type === 1) {
    throw new Error('HUE_UNAUTHORIZED')
  }
}

export const getLights = async (): Promise<Record<string, Light>> => {
  const res = await fetch(`${apiBase()}/lights`, { signal: withTimeout() })
  const json = await res.json()
  assertAuthOk(json)
  return Object.fromEntries(
    Object.entries(json as Record<string, Omit<Light, 'id'>>).map(
      ([id, light]) => [id, { ...light, id }]
    )
  )
}

export const getGroups = async (): Promise<Record<string, Group>> => {
  const res = await fetch(`${apiBase()}/groups`, { signal: withTimeout() })
  const json = await res.json()
  assertAuthOk(json)
  return Object.fromEntries(
    Object.entries(json as Record<string, Omit<Group, 'id'>>).map(
      ([id, group]) => [id, { ...group, id }]
    )
  )
}

export const getEnrichedGroups = async (): Promise<EnrichedGroup[]> => {
  const [groups, lights] = await Promise.all([getGroups(), getLights()])
  return Object.values(groups).map((group) => ({
    ...group,
    lightDetails: group.lights.map((id) => lights[id]).filter(Boolean)
  }))
}

export const setLightState = async (
  lightId: string,
  state: Partial<LightState>
) => {
  const res = await fetch(`${apiBase()}/lights/${lightId}/state`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(state),
    signal: withTimeout()
  })
  return res.json()
}

export interface Scene {
  id: string
  name: string
  group: string
  type: 'static' | 'smart'
}

export const setGroupAction = async (
  groupId: string,
  action: { on?: boolean; bri?: number }
) => {
  const res = await fetch(`${apiBase()}/groups/${groupId}/action`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(action),
    signal: withTimeout()
  })
  return res.json()
}

export const getScenes = async (): Promise<Scene[]> => {
  const res = await fetch(`${apiBase()}/scenes`, { signal: withTimeout() })
  const json = (await res.json()) as Record<
    string,
    { name: string; group?: string; type: string }
  >
  return Object.entries(json)
    .filter(([, v]) => v.type === 'GroupScene' && v.group)
    .map(
      ([id, v]): Scene => ({
        id,
        name: v.name,
        group: v.group!,
        type: 'static'
      })
    )
}

export interface SceneLightState {
  on: boolean
  bri?: number
  ct?: number
}

// The bulk /scenes list omits per-light targets -- only the single-scene GET
// includes `lightstates` -- so verifying a room's current state against its
// scheduled scene needs this per-id fetch.
export const getSceneLightstates = async (
  sceneId: string
): Promise<Record<string, SceneLightState>> => {
  const res = await fetch(`${apiBase()}/scenes/${sceneId}`, {
    signal: withTimeout()
  })
  const json = (await res.json()) as {
    lightstates?: Record<string, SceneLightState>
  }
  return json.lightstates ?? {}
}

// Returns a map of v2 room UUID → v1 group ID, matched by room name
const getV2ToV1GroupMap = async (): Promise<Record<string, string>> => {
  const [v2Res, v1Groups] = await Promise.all([
    fetch(`${v2Base()}/room`, {
      headers: v2Headers(),
      dispatcher: v2Agent,
      signal: withTimeout()
    } as Parameters<typeof fetch>[1]),
    getGroups()
  ])
  const v2Data = (await v2Res.json()) as {
    data: Array<{ id: string; metadata: { name: string } }>
  }
  const nameToV1Id = Object.fromEntries(
    Object.entries(v1Groups).map(([id, g]) => [g.name, id])
  )
  return Object.fromEntries(
    v2Data.data.map((r) => [r.id, nameToV1Id[r.metadata.name] ?? ''])
  )
}

export const getSmartScenes = async (): Promise<Scene[]> => {
  const [res, v2ToV1] = await Promise.all([
    fetch(`${v2Base()}/smart_scene`, {
      headers: v2Headers(),
      dispatcher: v2Agent,
      signal: withTimeout()
    } as Parameters<typeof fetch>[1]),
    getV2ToV1GroupMap()
  ])
  const json = (await res.json()) as {
    data: Array<{
      id: string
      metadata: { name: string }
      group: { rid: string }
    }>
  }
  return json.data
    .filter((ss) => v2ToV1[ss.group.rid])
    .map((ss) => ({
      id: ss.id,
      name: ss.metadata.name,
      group: v2ToV1[ss.group.rid],
      type: 'smart' as const
    }))
}

export const activateSmartScene = async (smartSceneId: string) => {
  const res = await fetch(`${v2Base()}/smart_scene/${smartSceneId}`, {
    method: 'PUT',
    headers: { ...v2Headers(), 'Content-Type': 'application/json' },
    dispatcher: v2Agent,
    body: JSON.stringify({ recall: { action: 'activate' } }),
    signal: withTimeout()
  } as Parameters<typeof fetch>[1])
  return res.json()
}

// v2 resource ids don't match the v1 numeric light ids used everywhere else
// in this app -- every v2 resource carries its v1-API equivalent back in
// `id_v1` (e.g. "/lights/2"), which is how one maps to the other.
const getV2LightIdMap = async (): Promise<Record<string, string>> => {
  const res = await fetch(`${v2Base()}/light`, {
    headers: v2Headers(),
    dispatcher: v2Agent,
    signal: withTimeout()
  } as Parameters<typeof fetch>[1])
  const json = (await res.json()) as {
    data: Array<{ id: string; id_v1?: string }>
  }
  return Object.fromEntries(
    json.data
      .filter((l) => l.id_v1)
      .map((l) => [l.id, l.id_v1!.replace('/lights/', '')])
  )
}

interface V2SmartSceneTimeslot {
  target: { rid: string }
}
interface V2SmartScene {
  week_timeslots: Array<{ timeslots: V2SmartSceneTimeslot[]; recurrence: string[] }>
  active_timeslot?: { timeslot_id: number; weekday: string }
}

// A smart scene cycles through several target static scenes over the day on
// the bridge's own clock (see `activateSmartScene`'s comment). This looks up
// which one is current, so a caller can verify the room actually reached it
// rather than just trusting the `recall: activate` call above succeeded.
const getSmartSceneActiveTargetSceneId = async (
  smartSceneId: string
): Promise<string | null> => {
  const res = await fetch(`${v2Base()}/smart_scene/${smartSceneId}`, {
    headers: v2Headers(),
    dispatcher: v2Agent,
    signal: withTimeout()
  } as Parameters<typeof fetch>[1])
  const json = (await res.json()) as { data: V2SmartScene[] }
  const smartScene = json.data[0]
  const active = smartScene?.active_timeslot
  if (!active) return null
  const week = smartScene.week_timeslots.find((w) =>
    w.recurrence.includes(active.weekday)
  )
  return week?.timeslots[active.timeslot_id]?.target.rid ?? null
}

interface V2SceneAction {
  target: { rid: string }
  action: {
    on?: { on: boolean }
    dimming?: { brightness: number }
    color_temperature?: { mirek: number }
  }
}

// The per-light targets of whichever static scene a smart scene is
// currently cycled to, in the same shape `getSceneLightstates` returns for a
// plain static scene -- so callers can verify convergence with the same
// comparison logic regardless of scene type.
export const getSmartSceneTargetLightstates = async (
  smartSceneId: string
): Promise<Record<string, SceneLightState>> => {
  const targetSceneId = await getSmartSceneActiveTargetSceneId(smartSceneId)
  if (!targetSceneId) return {}

  const [sceneRes, v2LightIds] = await Promise.all([
    fetch(`${v2Base()}/scene/${targetSceneId}`, {
      headers: v2Headers(),
      dispatcher: v2Agent,
      signal: withTimeout()
    } as Parameters<typeof fetch>[1]),
    getV2LightIdMap()
  ])
  const json = (await sceneRes.json()) as {
    data: Array<{ actions: V2SceneAction[] }>
  }
  const actions = json.data[0]?.actions ?? []

  const lightstates: Record<string, SceneLightState> = {}
  for (const { target, action } of actions) {
    const v1Id = v2LightIds[target.rid]
    if (!v1Id || !action.on) continue
    lightstates[v1Id] = {
      on: action.on.on,
      ...(action.dimming && {
        bri: Math.round((action.dimming.brightness / 100) * 254)
      }),
      ...(action.color_temperature && { ct: action.color_temperature.mirek })
    }
  }
  return lightstates
}

export const activateScene = async (groupId: string, sceneId: string) => {
  const res = await fetch(`${apiBase()}/groups/${groupId}/action`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scene: sceneId }),
    signal: withTimeout()
  })
  return res.json()
}

export interface Sensor {
  id: string
  name: string
  state: {
    presence?: boolean
    lastupdated?: string
  }
}

// Includes Hue's own motion sensors as well as third-party (e.g. IKEA
// TRÅDFRI) presence sensors paired directly to the bridge — both expose a
// boolean `state.presence`, which is what we filter on.
export const getSensors = async (): Promise<Sensor[]> => {
  const res = await fetch(`${apiBase()}/sensors`, { signal: withTimeout() })
  const json = await res.json()
  assertAuthOk(json)
  return Object.entries(json as Record<string, Omit<Sensor, 'id'>>)
    .filter(([, s]) => typeof s.state?.presence === 'boolean')
    .map(([id, s]) => ({ ...s, id }))
}

// Physical wall switches (Hue Dimmer, Hue Tap) that the official app has
// paired to a room show up in that room's own `sensors` list (see Group).
// Filtering the bridge's sensors down to actual button accessories lets
// callers cross-reference a group's `sensors` array to tell "this room has a
// switch a person can press" from "this room is only reachable via a
// physical breaker" — no manual per-room config needed. Deliberately
// excludes motion/presence sensor types (Hue's own, and third-party ones
// like IKEA TRÅDFRI — see getSensors): a room with a motion sensor but no
// switch listed here still has no way for a person to press "on", so it
// must still be treated as breaker-only.
const SWITCH_SENSOR_TYPES = new Set(['ZLLSwitch', 'ZGPSwitch'])

export const getSwitchSensorIds = async (): Promise<Set<string>> => {
  const res = await fetch(`${apiBase()}/sensors`, { signal: withTimeout() })
  const json = await res.json()
  assertAuthOk(json)
  return new Set(
    Object.entries(json as Record<string, { type: string }>)
      .filter(([, s]) => SWITCH_SENSOR_TYPES.has(s.type))
      .map(([id]) => id)
  )
}
