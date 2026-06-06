import type { Group } from '../types'
import { setLightState, setGroupState } from '../api'

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

interface Props {
  group: Group
  onUpdate: (updated: Group) => void
}

export function GroupCard({ group, onUpdate }: Props) {
  const { id, name, type, class: cls, state, lightDetails } = group
  const isOn = state.any_on

  const handleGroupToggle = async () => {
    const next = !isOn
    onUpdate({
      ...group,
      state: { all_on: next, any_on: next },
      lightDetails: lightDetails.map(l => ({
        ...l,
        state: { ...l.state, on: next }
      }))
    })
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
    </div>
  )
}
