import { useState } from 'react'
import type { Group, Scene } from '../types'
import { setLightState, setGroupState, activateScene } from '../api'

const CLASS_ICONS: Record<string, string> = {
  'Living room': '🛋',
  Office: '💻',
  Bedroom: '🛏',
  Bathroom: '🚿',
  Kitchen: '🍳',
  Dining: '🍽',
  Hallway: '🚪',
  Garage: '🚗',
  Garden: '🌿',
  Terrace: '🌅',
  Gym: '🏋',
  'Outdoor social': '🌳',
  Other: '💡'
}

const classIcon = (cls: string) => CLASS_ICONS[cls] ?? '💡'

// Scenes surfaced at top level; everything else collapses under "More"
const PINNED = new Set(['Natural light', 'Rest', 'Nightlight'])

interface Props {
  group: Group
  zones?: Group[]
  scenes?: Scene[]
  onUpdate: (updated: Group) => void
}

export function GroupCard({ group, zones, scenes = [], onUpdate }: Props) {
  const { id, name, type, class: cls, state, lightDetails } = group
  const isOn = state.any_on

  const [zonesOpen, setZonesOpen] = useState(false)
  const [moreOpen, setMoreOpen] = useState(false)
  const [activeSceneId, setActiveSceneId] = useState<string | null>(null)

  const pinnedScenes = scenes.filter(s => PINNED.has(s.name))
  const moreScenes = scenes.filter(s => !PINNED.has(s.name))

  const handleGroupToggle = async () => {
    const next = !isOn
    onUpdate({
      ...group,
      state: { all_on: next, any_on: next },
      lightDetails: lightDetails.map(l => ({ ...l, state: { ...l.state, on: next } }))
    })
    setActiveSceneId(null)
    await setGroupState(id, next)
  }

  const handleLightToggle = async (lightId: string, currentOn: boolean) => {
    const next = !currentOn
    onUpdate({
      ...group,
      lightDetails: lightDetails.map(l =>
        l.id === lightId ? { ...l, state: { ...l.state, on: next } } : l
      )
    })
    await setLightState(lightId, { on: next })
  }

  const handleZoneToggle = async (zone: Group) => {
    const next = !zone.state.any_on
    onUpdate({
      ...zone,
      state: { all_on: next, any_on: next },
      lightDetails: zone.lightDetails.map(l => ({ ...l, state: { ...l.state, on: next } }))
    })
    await setGroupState(zone.id, next)
  }

  const handleSceneActivate = async (scene: Scene) => {
    setActiveSceneId(scene.id)
    onUpdate({ ...group, state: { all_on: true, any_on: true }, lightDetails })
    await activateScene(id, scene.id, scene.type)
  }

  return (
    <div className={`group-card ${isOn ? 'group-card--on' : ''}`}>
      <div className="group-card__header">
        <div className="group-card__title">
          <span className="group-card__icon">{classIcon(cls)}</span>
          <div>
            <span className="group-card__name">{name}</span>
            <span className="group-card__type">{type}</span>
          </div>
        </div>
        <button
          className={`toggle toggle--group ${isOn ? 'toggle--on' : ''}`}
          onClick={handleGroupToggle}
          title={isOn ? 'Turn off all' : 'Turn on all'}
        >
          <span className="toggle__track">
            <span className="toggle__thumb" />
          </span>
        </button>
      </div>

      <ul className="light-list">
        {lightDetails.map(light => (
          <li
            key={light.id}
            className={`light-row ${light.state.on ? 'light-row--on' : ''} ${!light.state.reachable ? 'light-row--unreachable' : ''}`}
          >
            <span className="light-row__dot" />
            <span className="light-row__name">{light.name}</span>
            {!light.state.reachable && (
              <span className="light-row__badge">unreachable</span>
            )}
            <button
              className={`toggle toggle--light ${light.state.on ? 'toggle--on' : ''}`}
              onClick={() => handleLightToggle(light.id, light.state.on)}
              disabled={!light.state.reachable}
              title={light.state.on ? 'Turn off' : 'Turn on'}
            >
              <span className="toggle__track">
                <span className="toggle__thumb" />
              </span>
            </button>
          </li>
        ))}
        {lightDetails.length === 0 && (
          <li className="light-list__empty">No lights</li>
        )}
      </ul>

      {scenes.length > 0 && (
        <div className="scene-section">
          <div className="scene-row">
            {pinnedScenes.map(scene => (
              <button
                key={scene.id}
                className={`scene-pill ${activeSceneId === scene.id ? 'scene-pill--active' : ''}`}
                onClick={() => handleSceneActivate(scene)}
              >
                {scene.name}
              </button>
            ))}
            {moreScenes.length > 0 && (
              <button
                className={`scene-pill scene-pill--more ${moreOpen ? 'scene-pill--more-open' : ''}`}
                onClick={() => setMoreOpen(o => !o)}
              >
                More
                <span className={`chevron ${moreOpen ? 'chevron--open' : ''}`}>›</span>
              </button>
            )}
          </div>
          {moreOpen && (
            <div className="scene-row scene-row--more">
              {moreScenes.map(scene => (
                <button
                  key={scene.id}
                  className={`scene-pill ${activeSceneId === scene.id ? 'scene-pill--active' : ''}`}
                  onClick={() => handleSceneActivate(scene)}
                >
                  {scene.name}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {zones && zones.length > 0 && (
        <div className="zone-section">
          <button
            className="zone-section__toggle"
            onClick={() => setZonesOpen(o => !o)}
          >
            <span>Zones ({zones.length})</span>
            <span className={`chevron ${zonesOpen ? 'chevron--open' : ''}`}>›</span>
          </button>

          {zonesOpen && (
            <ul className="zone-list">
              {zones.map(zone => (
                <li key={zone.id} className="nested-zone">
                  <div className="nested-zone__header">
                    <span className="nested-zone__name">{zone.name}</span>
                    <div className="nested-zone__lights">
                      {zone.lightDetails.map(l => (
                        <span
                          key={l.id}
                          className={`nested-zone__dot ${l.state.on ? 'nested-zone__dot--on' : ''}`}
                          title={l.name}
                        />
                      ))}
                    </div>
                    <button
                      className={`toggle toggle--light ${zone.state.any_on ? 'toggle--on' : ''}`}
                      onClick={() => handleZoneToggle(zone)}
                      title={zone.state.any_on ? 'Turn off zone' : 'Turn on zone'}
                    >
                      <span className="toggle__track">
                        <span className="toggle__thumb" />
                      </span>
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}
