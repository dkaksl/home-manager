import fetch from 'node-fetch'
import { config } from 'dotenv'
import { getUser } from '../src/user'

config()

const HUE_IP = process.env.HUE_IP || '192.168.1.182'

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

const apiBase = () => `http://${HUE_IP}/api/${getUser()}`

export const getLights = async (): Promise<Record<string, Light>> => {
  const res = await fetch(`${apiBase()}/lights`)
  const json = (await res.json()) as Record<string, Omit<Light, 'id'>>
  return Object.fromEntries(
    Object.entries(json).map(([id, light]) => [id, { ...light, id }])
  )
}

export const getGroups = async (): Promise<Record<string, Group>> => {
  const res = await fetch(`${apiBase()}/groups`)
  const json = (await res.json()) as Record<string, Omit<Group, 'id'>>
  return Object.fromEntries(
    Object.entries(json).map(([id, group]) => [id, { ...group, id }])
  )
}

export const getEnrichedGroups = async (): Promise<EnrichedGroup[]> => {
  const [groups, lights] = await Promise.all([getGroups(), getLights()])
  return Object.values(groups).map(group => ({
    ...group,
    lightDetails: group.lights.map(id => lights[id]).filter(Boolean)
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
