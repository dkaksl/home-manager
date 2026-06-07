import type { Group, LightState, Scene, RoomSchedule } from './types'
import { apiUrl, authHeaders } from './serverConfig'

export type ApiErrorCode = 'login_failed' | 'not_configured' | 'unauthorized' | 'unknown'

export class ApiError extends Error {
  constructor(public readonly code: ApiErrorCode) {
    super(code)
  }
}

const apiFetch = (path: string, init: RequestInit = {}): Promise<Response> =>
  fetch(apiUrl(path), {
    ...init,
    headers: { ...authHeaders(), ...init.headers }
  })

// Our own Basic Auth challenge always sets WWW-Authenticate; the bridge's
// 401 (relayed via HUE_UNAUTHORIZED) does not, so this tells them apart.
const checkAuthResponse = (r: Response) => {
  if (r.status === 401 && r.headers.has('WWW-Authenticate')) throw new ApiError('login_failed')
}

export const fetchGroups = (): Promise<Group[]> =>
  apiFetch('/api/groups').then((r) => {
    checkAuthResponse(r)
    if (r.status === 503) throw new ApiError('not_configured')
    if (r.status === 401) throw new ApiError('unauthorized')
    if (!r.ok) throw new ApiError('unknown')
    return r.json()
  })

export const setLightState = (
  id: string,
  state: Partial<LightState>
): Promise<unknown> =>
  apiFetch(`/api/lights/${id}/state`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(state)
  }).then((r) => r.json())

export const setGroupState = (id: string, on: boolean): Promise<unknown> =>
  apiFetch(`/api/groups/${id}/state`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ on })
  }).then((r) => r.json())

export const fetchScenes = (): Promise<Scene[]> =>
  apiFetch('/api/scenes').then((r) => {
    checkAuthResponse(r)
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    return r.json()
  })

export const activateScene = (
  groupId: string,
  sceneId: string,
  type: 'static' | 'smart'
): Promise<unknown> =>
  apiFetch(`/api/groups/${groupId}/scene`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sceneId, type })
  }).then((r) => r.json())

export const fetchSchedules = (): Promise<Record<string, RoomSchedule>> =>
  apiFetch('/api/schedules').then((r) => {
    checkAuthResponse(r)
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    return r.json()
  })

export const saveSchedule = (
  groupId: string,
  schedule: RoomSchedule
): Promise<unknown> =>
  apiFetch(`/api/schedules/${groupId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(schedule)
  }).then((r) => r.json())
