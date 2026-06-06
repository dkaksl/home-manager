import type { Group, LightState, Scene } from './types'

export type ApiErrorCode = 'not_configured' | 'unauthorized' | 'unknown'

export class ApiError extends Error {
  constructor(public readonly code: ApiErrorCode) {
    super(code)
  }
}

export const fetchGroups = (): Promise<Group[]> =>
  fetch('/api/groups').then((r) => {
    if (r.status === 503) throw new ApiError('not_configured')
    if (r.status === 401) throw new ApiError('unauthorized')
    if (!r.ok) throw new ApiError('unknown')
    return r.json()
  })

export const setLightState = (
  id: string,
  state: Partial<LightState>
): Promise<unknown> =>
  fetch(`/api/lights/${id}/state`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(state)
  }).then((r) => r.json())

export const setGroupState = (id: string, on: boolean): Promise<unknown> =>
  fetch(`/api/groups/${id}/state`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ on })
  }).then((r) => r.json())

export const fetchScenes = (): Promise<Scene[]> =>
  fetch('/api/scenes').then((r) => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    return r.json()
  })

export const activateScene = (
  groupId: string,
  sceneId: string,
  type: 'static' | 'smart'
): Promise<unknown> =>
  fetch(`/api/groups/${groupId}/scene`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sceneId, type })
  }).then((r) => r.json())
