import { useState, useEffect, useCallback } from 'react'
import type { Group, Scene, RoomSchedule } from './types'
import { fetchGroups, fetchScenes, fetchSchedules, saveSchedule, ApiError, type ApiErrorCode } from './api'
import { GroupCard } from './components/GroupCard'
import { SetupScreen } from './components/SetupScreen'
import { ConnectScreen } from './components/ConnectScreen'
import { LoginScreen } from './components/LoginScreen'
import {
  loadStoredHost,
  storeHost,
  clearStoredHost,
  loadStoredCredentials,
  storeCredentials,
  clearStoredCredentials,
  type Credentials
} from './serverConfig'
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
  const [host, setHost] = useState<string | null>(() => loadStoredHost())
  const [credentials, setCredentials] = useState<Credentials | null>(() => loadStoredCredentials())
  const [loginError, setLoginError] = useState(false)
  const [verifyingLogin, setVerifyingLogin] = useState(false)
  const [groups, setGroups] = useState<Group[]>([])
  const [scenesMap, setScenesMap] = useState<Record<string, Scene[]>>({})
  const [schedulesMap, setSchedulesMap] = useState<Record<string, RoomSchedule>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [setupError, setSetupError] = useState<ApiErrorCode | null>(null)
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null)
  const [orphansOpen, setOrphansOpen] = useState(false)

  const loadGroups = useCallback(async () => {
    try {
      const data = await fetchGroups()
      setGroups(data)
      setLastRefresh(new Date())
      setError(null)
      setSetupError(null)
      setLoginError(false)
    } catch (err) {
      if (err instanceof ApiError && err.code === 'login_failed') {
        setLoginError(true)
      } else if (err instanceof ApiError && (err.code === 'not_configured' || err.code === 'unauthorized')) {
        setSetupError(err.code)
      } else {
        setError('Could not reach the server. Is it running?')
      }
    } finally {
      setVerifyingLogin(false)
    }
  }, [])

  const ready = !!host && !!credentials

  useEffect(() => {
    if (!ready) return
    loadGroups().finally(() => setLoading(false))
    const interval = setInterval(loadGroups, 10_000)
    return () => clearInterval(interval)
  }, [loadGroups, ready])

  useEffect(() => {
    if (!ready) return
    fetchScenes().then(scenes => {
      const map: Record<string, Scene[]> = {}
      for (const scene of scenes) {
        if (!map[scene.group]) map[scene.group] = []
        map[scene.group].push(scene)
      }
      setScenesMap(map)
    }).catch(() => {})
  }, [ready])

  useEffect(() => {
    if (!ready) return
    fetchSchedules().then(setSchedulesMap).catch(() => {})
  }, [ready])

  const handleConnect = (newHost: string) => {
    storeHost(newHost)
    setHost(newHost)
  }

  const handleLogin = (username: string, password: string) => {
    const newCredentials = { username, password }
    storeCredentials(newCredentials)
    setCredentials(newCredentials)
    setLoginError(false)
    setVerifyingLogin(true)
  }

  const handleDisconnect = () => {
    clearStoredHost()
    clearStoredCredentials()
    setHost(null)
    setCredentials(null)
    setGroups([])
    setScenesMap({})
    setSchedulesMap({})
    setLoading(true)
    setError(null)
    setSetupError(null)
    setLoginError(false)
    setVerifyingLogin(false)
    setLastRefresh(null)
  }

  const handleScheduleSave = async (groupId: string, schedule: RoomSchedule) => {
    await saveSchedule(groupId, schedule)
    setSchedulesMap(prev => ({ ...prev, [groupId]: schedule }))
  }

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
          {host && (
            <button
              className="refresh-btn"
              onClick={handleDisconnect}
              title={
                credentials
                  ? `Connected as ${credentials.username}@${host} — click to disconnect`
                  : `Connected to ${host} — click to disconnect`
              }
            >
              ⚙
            </button>
          )}
          <button className="refresh-btn" onClick={loadGroups} title="Refresh">
            ↻
          </button>
        </div>
      </header>

      <div className="app-body">
        {error && <div className="error-banner">{error}</div>}

        {!host ? (
          <ConnectScreen onConnect={handleConnect} />
        ) : !credentials || loginError || verifyingLogin ? (
          <LoginScreen error={loginError} loading={verifyingLogin} onLogin={handleLogin} />
        ) : setupError ? (
          <SetupScreen reason={setupError} />
        ) : loading ? (
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
                    scenes={scenesMap[room.id] ?? []}
                    schedule={schedulesMap[room.id]}
                    onUpdate={updateGroup}
                    onScheduleSave={s => handleScheduleSave(room.id, s)}
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
