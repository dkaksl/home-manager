import type { Group, LightState } from './types'

export const fetchGroups = (): Promise<Group[]> =>
  fetch('/api/groups').then(r => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
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
  }).then(r => r.json())

export const setGroupState = (
  id: string,
  on: boolean
): Promise<unknown> =>
  fetch(`/api/groups/${id}/state`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ on })
  }).then(r => r.json())
