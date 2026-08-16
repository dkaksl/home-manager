import { useState } from 'react'
import type { Group, Scene, RoomSchedule, Sensor } from '../types'
import { setLightState, setGroupState, activateScene } from '../api'
import { sceneIcon } from '../sceneIcons'
import { ScheduleModal } from './ScheduleModal'

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

const SCENE_PRIORITY = [
  'Natural light',
  'Read',
  'Reading',
  'Rest',
  'Nightlight'
]

const sortScenes = (scenes: Scene[]): Scene[] =>
  [...scenes].sort((a, b) => {
    const ai = SCENE_PRIORITY.indexOf(a.name)
    const bi = SCENE_PRIORITY.indexOf(b.name)
    if (ai === -1 && bi === -1) return a.name.localeCompare(b.name)
    if (ai === -1) return 1
    if (bi === -1) return -1
    return ai - bi
  })

interface Props {
  group: Group
  zones?: Group[]
  scenes?: Scene[]
  schedule?: RoomSchedule
  sensors?: Sensor[]
  onUpdate: (updated: Group) => void
  onScheduleSave?: (schedule: RoomSchedule) => Promise<void>
  onKillSwitchToggle?: (enabled: boolean) => Promise<void>
}

export function GroupCard({
  group,
  zones,
  scenes = [],
  schedule,
  sensors = [],
  onUpdate,
  onScheduleSave,
  onKillSwitchToggle
}: Props) {
  const { id, name, type, class: cls, state, lightDetails } = group
  const isOn = state.any_on

  const [lightsOpen, setLightsOpen] = useState(false)
  const [zonesOpen, setZonesOpen] = useState(false)
  const [moreOpen, setMoreOpen] = useState(false)
  const [activeSceneId, setActiveSceneId] = useState<string | null>(null)
  const [scheduleOpen, setScheduleOpen] = useState(false)

  const scheduleActive = schedule?.enabled ?? false
  const killSwitchActive = schedule?.killSwitch ?? false

  const sorted = sortScenes(scenes)
  const visibleScenes = sorted.slice(0, 3)
  const moreScenes = sorted.slice(3)

  const handleGroupToggle = async () => {
    const next = !isOn
    onUpdate({
      ...group,
      state: { all_on: next, any_on: next },
      lightDetails: lightDetails.map((l) => ({
        ...l,
        state: { ...l.state, on: next }
      }))
    })
    setActiveSceneId(null)
    await setGroupState(id, next)
  }

  const handleLightToggle = async (lightId: string, currentOn: boolean) => {
    const next = !currentOn
    onUpdate({
      ...group,
      lightDetails: lightDetails.map((l) =>
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
      lightDetails: zone.lightDetails.map((l) => ({
        ...l,
        state: { ...l.state, on: next }
      }))
    })
    await setGroupState(zone.id, next)
  }

  const handleSceneActivate = async (scene: Scene) => {
    setActiveSceneId(scene.id)
    onUpdate({ ...group, state: { all_on: true, any_on: true }, lightDetails })
    await activateScene(id, scene.id, scene.type)
  }

  const handleKillSwitchToggle = async () => {
    if (!onKillSwitchToggle) return
    const next = !killSwitchActive
    if (next) {
      onUpdate({
        ...group,
        state: { all_on: false, any_on: false },
        lightDetails: lightDetails.map((l) => ({ ...l, state: { ...l.state, on: false } }))
      })
    }
    await onKillSwitchToggle(next)
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
        <div className="group-card__actions">
          {type === 'Room' && (
            <button
              className={`schedule-btn ${scheduleActive ? 'schedule-btn--active' : ''}`}
              onClick={() => setScheduleOpen(true)}
              title="Schedule"
            >
              ⏰
            </button>
          )}
          {type === 'Room' && onKillSwitchToggle && (
            <button
              className={`kill-switch-btn ${killSwitchActive ? 'kill-switch-btn--active' : ''}`}
              onClick={handleKillSwitchToggle}
              title={killSwitchActive ? 'Kill switch on — tap to release' : 'Kill switch'}
            >
              🚫
            </button>
          )}
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
      </div>

      {scheduleOpen && onScheduleSave && (
        <ScheduleModal
          group={group}
          scenes={scenes}
          sensors={sensors}
          initialSchedule={schedule}
          onClose={() => setScheduleOpen(false)}
          onSave={onScheduleSave}
        />
      )}

      {scenes.length > 0 && (
        <div className="scene-section">
          <div className="scene-grid">
            {visibleScenes.map((scene) => (
              <button
                key={scene.id}
                className={`scene-btn ${activeSceneId === scene.id ? 'scene-btn--active' : ''}`}
                onClick={() => handleSceneActivate(scene)}
              >
                <span className="scene-btn__icon">{sceneIcon(scene.name)}</span>
                <span className="scene-btn__label">{scene.name}</span>
              </button>
            ))}
            {moreScenes.length > 0 && (
              <button
                className={`scene-btn scene-btn--more ${moreOpen ? 'scene-btn--more-open' : ''}`}
                onClick={() => setMoreOpen((o) => !o)}
              >
                <span className="scene-btn__icon">
                  {moreOpen ? '✕' : '···'}
                </span>
                <span className="scene-btn__label">
                  {moreOpen ? 'Less' : 'More'}
                </span>
              </button>
            )}
          </div>
          {moreOpen && (
            <div className="scene-grid scene-grid--more">
              {moreScenes.map((scene) => (
                <button
                  key={scene.id}
                  className={`scene-btn ${activeSceneId === scene.id ? 'scene-btn--active' : ''}`}
                  onClick={() => handleSceneActivate(scene)}
                >
                  <span className="scene-btn__icon">
                    {sceneIcon(scene.name)}
                  </span>
                  <span className="scene-btn__label">{scene.name}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="lights-section">
        <button
          className="lights-section__toggle"
          onClick={() => setLightsOpen((o) => !o)}
        >
          <span>Lights ({lightDetails.length})</span>
          <span className={`chevron ${lightsOpen ? 'chevron--open' : ''}`}>
            ›
          </span>
        </button>
        {lightsOpen && (
          <ul className="light-list">
            {lightDetails.map((light) => (
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
        )}
      </div>

      {zones && zones.length > 0 && (
        <div className="zone-section">
          <button
            className="zone-section__toggle"
            onClick={() => setZonesOpen((o) => !o)}
          >
            <span>Zones ({zones.length})</span>
            <span className={`chevron ${zonesOpen ? 'chevron--open' : ''}`}>
              ›
            </span>
          </button>

          {zonesOpen && (
            <ul className="zone-list">
              {zones.map((zone) => (
                <li key={zone.id} className="nested-zone">
                  <div className="nested-zone__header">
                    <span className="nested-zone__name">{zone.name}</span>
                    <div className="nested-zone__lights">
                      {zone.lightDetails.map((l) => (
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
                      title={
                        zone.state.any_on ? 'Turn off zone' : 'Turn on zone'
                      }
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
