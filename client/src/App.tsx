import { useState, useEffect, useCallback } from 'react'
import type { Group } from './types'
import { fetchGroups } from './api'
import { GroupCard } from './components/GroupCard'
import './App.css'

function linkZonesToRooms(groups: Group[]): {
  rooms: Group[]
  linkedZones: Record<string, Group[]>
  orphanZones: Group[]
} {
  const rooms = groups.filter(g => g.type === 'Room')
  const zones = groups.filter(g => g.type === 'Zone')

  const linkedZones: Record<string, Group[]> = {}
  const orphanZones: Group[] = []

  for (const zone of zones) {
    const candidates = rooms.filter(room =>
      zone.lights.every(lid => room.lights.includes(lid))
    )
    if (candidates.length === 0) {
      orphanZones.push(zone)
    } else {
      // tightest fit: room with fewest lights that fully contains the zone
      const parent = candidates.reduce((best, r) =>
        r.lights.length < best.lights.length ? r : best
      )
      linkedZones[parent.id] = [...(linkedZones[parent.id] ?? []), zone]
    }
  }

  return { rooms, linkedZones, orphanZones }
}

export default function App() {
  const [groups, setGroups] = useState<Group[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null)
  const [orphansOpen, setOrphansOpen] = useState(false)

  const loadGroups = useCallback(async () => {
    try {
      const data = await fetchGroups()
      setGroups(data)
      setLastRefresh(new Date())
      setError(null)
    } catch {
      setError('Could not reach the server. Is it running?')
    }
  }, [])

  useEffect(() => {
    loadGroups().finally(() => setLoading(false))
    const interval = setInterval(loadGroups, 10_000)
    return () => clearInterval(interval)
  }, [loadGroups])

  const updateGroup = (updated: Group) => {
    setGroups(prev => prev.map(g => (g.id === updated.id ? updated : g)))
  }

  const { rooms, linkedZones, orphanZones } = linkZonesToRooms(groups)

  return (
    <div className="app">
      <header className="app-header">
        <div className="app-header__left">
          <span className="app-header__logo">💡</span>
          <h1 className="app-header__title">Hue Manager</h1>
        </div>
        <div className="app-header__right">
          {lastRefresh && (
            <span className="app-header__ts">
              {lastRefresh.toLocaleTimeString()}
            </span>
          )}
          <button className="refresh-btn" onClick={loadGroups} title="Refresh">
            ↻
          </button>
        </div>
      </header>

      <div className="app-body">
        {error && <div className="error-banner">{error}</div>}

        {loading ? (
          <div className="loading">
            <div className="loading__spinner" />
            <span>Connecting to bridge…</span>
          </div>
        ) : (
          <>
            <section className="section">
              <h2 className="section__heading">
                Rooms
                <span className="section__count">{rooms.length}</span>
              </h2>
              <div className="group-grid">
                {rooms.map(room => (
                  <GroupCard
                    key={room.id}
                    group={room}
                    zones={linkedZones[room.id]}
                    onUpdate={updateGroup}
                  />
                ))}
              </div>
            </section>

            {orphanZones.length > 0 && (
              <section className="section">
                <button
                  className="section__collapse-btn"
                  onClick={() => setOrphansOpen(o => !o)}
                >
                  <h2 className="section__heading">
                    Zones
                    <span className="section__count">{orphanZones.length}</span>
                  </h2>
                  <span className={`chevron ${orphansOpen ? 'chevron--open' : ''}`}>
                    ›
                  </span>
                </button>
                {orphansOpen && (
                  <div className="group-grid">
                    {orphanZones.map(zone => (
                      <GroupCard
                        key={zone.id}
                        group={zone}
                        onUpdate={updateGroup}
                      />
                    ))}
                  </div>
                )}
              </section>
            )}
          </>
        )}
      </div>
    </div>
  )
}
