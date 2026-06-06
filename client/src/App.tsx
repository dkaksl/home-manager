import { useState, useEffect, useCallback } from 'react'
import type { Group } from './types'
import { fetchGroups } from './api'
import { GroupCard } from './components/GroupCard'
import './App.css'

type Filter = 'All' | 'Room' | 'Zone'

export default function App() {
  const [groups, setGroups] = useState<Group[]>([])
  const [filter, setFilter] = useState<Filter>('All')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null)

  const loadGroups = useCallback(async () => {
    try {
      const data = await fetchGroups()
      setGroups(data)
      setLastRefresh(new Date())
      setError(null)
    } catch (e) {
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

  const visible = groups.filter(g =>
    filter === 'All' ? g.type !== 'Entertainment' : g.type === filter
  )

  const rooms = groups.filter(g => g.type === 'Room')
  const zones = groups.filter(g => g.type === 'Zone')

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
          <button
            className="refresh-btn"
            onClick={loadGroups}
            title="Refresh"
          >
            ↻
          </button>
        </div>
      </header>

      <div className="app-body">
        {error && <div className="error-banner">{error}</div>}

        <div className="filter-tabs">
          {(['All', 'Room', 'Zone'] as Filter[]).map(f => (
            <button
              key={f}
              className={`filter-tab ${filter === f ? 'filter-tab--active' : ''}`}
              onClick={() => setFilter(f)}
            >
              {f}
              <span className="filter-tab__count">
                {f === 'All'
                  ? groups.filter(g => g.type !== 'Entertainment').length
                  : f === 'Room'
                  ? rooms.length
                  : zones.length}
              </span>
            </button>
          ))}
        </div>

        {loading ? (
          <div className="loading">
            <div className="loading__spinner" />
            <span>Connecting to bridge…</span>
          </div>
        ) : (
          <div className="group-grid">
            {visible.map(group => (
              <GroupCard key={group.id} group={group} onUpdate={updateGroup} />
            ))}
            {visible.length === 0 && (
              <p className="empty-state">No {filter.toLowerCase()}s found.</p>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
