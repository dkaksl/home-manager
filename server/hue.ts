import { Agent } from 'undici'
import { config } from 'dotenv'

config()

const HUE_IP = process.env.HUE_IP || '192.168.1.182'
const HUE_USER = process.env.HUE_USER?.trim() ?? ''

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

export interface Light {
  id: string
  name: string
  type: string
  state: LightState
  manufacturername: string
  productname: string
  modelid: string
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
  const res = await fetch(`${apiBase()}/lights`)
  const json = await res.json()
  assertAuthOk(json)
  return Object.fromEntries(
    Object.entries(json as Record<string, Omit<Light, 'id'>>).map(
      ([id, light]) => [id, { ...light, id }]
    )
  )
}

export const getGroups = async (): Promise<Record<string, Group>> => {
  const res = await fetch(`${apiBase()}/groups`)
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
    body: JSON.stringify(state)
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
    body: JSON.stringify(action)
  })
  return res.json()
}

export const getScenes = async (): Promise<Scene[]> => {
  const res = await fetch(`${apiBase()}/scenes`)
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

// Returns a map of v2 room UUID → v1 group ID, matched by room name
const getV2ToV1GroupMap = async (): Promise<Record<string, string>> => {
  const [v2Res, v1Groups] = await Promise.all([
    fetch(`${v2Base()}/room`, {
      headers: v2Headers(),
      dispatcher: v2Agent
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
      dispatcher: v2Agent
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
    body: JSON.stringify({ recall: { action: 'activate' } })
  } as Parameters<typeof fetch>[1])
  return res.json()
}

export const activateScene = async (groupId: string, sceneId: string) => {
  const res = await fetch(`${apiBase()}/groups/${groupId}/action`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scene: sceneId })
  })
  return res.json()
}
