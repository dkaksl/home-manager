import { useState, type ReactNode } from 'react'
import type { AutoOffConfig, Group, Scene, Sensor, TimeSlot, RoomSchedule } from '../types'
import { sceneIcon } from '../sceneIcons'

const DEFAULT_AUTO_OFF: AutoOffConfig = {
  enabled: false,
  timeoutMinutes: 30,
  sensorId: null
}

// ── Time helpers ─────────────────────────────────────────────────────────

const HOURS = Array.from({ length: 24 }, (_, i) => String(i).padStart(2, '0'))
const MINUTES = [
  '00',
  '05',
  '10',
  '15',
  '20',
  '25',
  '30',
  '35',
  '40',
  '45',
  '50',
  '55'
]
const MAX_TIME = '23:55'

const toMin = (hhmm: string): number => {
  const [h, m] = hhmm.split(':').map(Number)
  return h * 60 + m
}

const fromMin = (total: number): string => {
  const clamped = Math.max(0, Math.min(toMin(MAX_TIME), total))
  return `${String(Math.floor(clamped / 60)).padStart(2, '0')}:${String(clamped % 60).padStart(2, '0')}`
}

const snap5 = (total: number) => Math.round(total / 5) * 5

// ── Constrained time select ──────────────────────────────────────────────

interface TimeSelectProps {
  value: string
  min?: string // HH:MM, inclusive
  max?: string // HH:MM, inclusive
  onChange: (v: string) => void
}

function TimeSelect({
  value,
  min = '00:00',
  max = MAX_TIME,
  onChange
}: TimeSelectProps) {
  const minTotal = toMin(min)
  const maxTotal = toMin(max)
  const clamped = Math.max(minTotal, Math.min(maxTotal, snap5(toMin(value))))
  const h = String(Math.floor(clamped / 60)).padStart(2, '0')
  const m = String(clamped % 60).padStart(2, '0')

  const minH = Math.floor(minTotal / 60)
  const maxH = Math.floor(maxTotal / 60)
  const minM = minTotal % 60
  const maxM = maxTotal % 60

  const availHours = HOURS.filter((hh) => {
    const n = parseInt(hh)
    return n >= minH && n <= maxH
  })

  const availMinutes = MINUTES.filter((mm) => {
    const hNum = parseInt(h)
    const mNum = parseInt(mm)
    if (hNum === minH && mNum < minM) return false
    if (hNum === maxH && mNum > maxM) return false
    return true
  })

  const handleHourChange = (newH: string) => {
    const raw = parseInt(newH) * 60 + parseInt(m)
    onChange(fromMin(Math.max(minTotal, Math.min(maxTotal, snap5(raw)))))
  }

  return (
    <span className="time-select">
      <select
        className="time-select__part"
        value={h}
        onChange={(e) => handleHourChange(e.target.value)}
      >
        {availHours.map((hh) => (
          <option key={hh} value={hh}>
            {hh}
          </option>
        ))}
      </select>
      <span className="time-select__sep">:</span>
      <select
        className="time-select__part"
        value={m}
        onChange={(e) => onChange(`${h}:${e.target.value}`)}
      >
        {availMinutes.map((mm) => (
          <option key={mm} value={mm}>
            {mm}
          </option>
        ))}
      </select>
    </span>
  )
}

// ── Per-slot constraints ─────────────────────────────────────────────────

const getConstraints = (slots: TimeSlot[], i: number) => {
  const prevEnd = i > 0 ? slots[i - 1].endTime : '00:00'
  const nextStart = i < slots.length - 1 ? slots[i + 1].startTime : MAX_TIME
  const currStart = slots[i].startTime
  const currEnd = slots[i].endTime
  return {
    // Start: must be >= prevEnd, at most 5 min before current end
    startMin: prevEnd,
    startMax: fromMin(Math.max(toMin(prevEnd), toMin(currEnd) - 5)),
    // End: at least 5 min after current start, must be <= nextStart
    endMin: fromMin(Math.min(toMin(nextStart), toMin(currStart) + 5)),
    endMax: nextStart
  }
}

// ── Sorting + sanitisation ───────────────────────────────────────────────

const byStartTime = (slots: TimeSlot[]): TimeSlot[] =>
  [...slots].sort((a, b) => toMin(a.startTime) - toMin(b.startTime))

// Snap loaded slot times to 5-min grid and clamp within their valid ranges.
// Guards against manually edited JSON files.
const sanitize = (slots: TimeSlot[]): TimeSlot[] => {
  const sorted = byStartTime(slots)
  return sorted.map((slot, i) => {
    const prevEnd = i > 0 ? sorted[i - 1].endTime : '00:00'
    const nextStart = i < sorted.length - 1 ? sorted[i + 1].startTime : MAX_TIME
    const s = snap5(
      Math.max(
        toMin(prevEnd),
        Math.min(toMin(slot.startTime), toMin(nextStart) - 5)
      )
    )
    const e = snap5(
      Math.max(s + 5, Math.min(toMin(slot.endTime), toMin(nextStart)))
    )
    return { ...slot, startTime: fromMin(s), endTime: fromMin(e) }
  })
}

// ── Modal ────────────────────────────────────────────────────────────────

interface Props {
  group: Group
  scenes: Scene[]
  sensors?: Sensor[]
  initialSchedule: RoomSchedule | undefined
  onClose: () => void
  onSave: (schedule: RoomSchedule) => Promise<void>
}

export function ScheduleModal({
  group,
  scenes,
  sensors = [],
  initialSchedule,
  onClose,
  onSave
}: Props) {
  const [enabled, setEnabled] = useState(initialSchedule?.enabled ?? false)
  const [slots, setSlots] = useState<TimeSlot[]>(() =>
    sanitize(initialSchedule?.slots ?? [])
  )
  const [autoOff, setAutoOff] = useState<AutoOffConfig>(
    initialSchedule?.autoOff ?? DEFAULT_AUTO_OFF
  )
  const [saving, setSaving] = useState(false)

  const updateSlot = (id: string, changes: Partial<TimeSlot>) =>
    setSlots((s) =>
      byStartTime(s.map((sl) => (sl.id === id ? { ...sl, ...changes } : sl)))
    )

  const removeSlot = (id: string) =>
    setSlots((s) => byStartTime(s.filter((sl) => sl.id !== id)))

  const handleSceneChange = (slotId: string, sceneId: string) => {
    if (sceneId === 'off') {
      updateSlot(slotId, { sceneId: 'off', sceneType: 'off' })
    } else {
      const scene = scenes.find((s) => s.id === sceneId)
      updateSlot(slotId, { sceneId, sceneType: scene?.type ?? 'static' })
    }
  }

  const addInGap = (gapStart: string, gapEnd: string) => {
    setSlots((s) =>
      byStartTime([
        ...s,
        {
          id: crypto.randomUUID(),
          startTime: gapStart,
          endTime: gapEnd,
          sceneId: 'off',
          sceneType: 'off'
        }
      ])
    )
  }

  const handleSave = async () => {
    setSaving(true)
    try {
      await onSave({ ...initialSchedule, groupId: group.id, enabled, slots, autoOff })
      onClose()
    } finally {
      setSaving(false)
    }
  }

  const renderSlots = (): ReactNode[] => {
    const items: ReactNode[] = []

    // Gap before first slot (if it doesn't start at 00:00)
    if (toMin(slots[0].startTime) > 0) {
      items.push(
        <button
          key="gap-before"
          className="slot-add-gap"
          onClick={() => addInGap('00:00', slots[0].startTime)}
        >
          + 00:00 – {slots[0].startTime}
        </button>
      )
    }

    slots.forEach((slot, i) => {
      const c = getConstraints(slots, i)
      items.push(
        <div key={slot.id} className="slot-row">
          <TimeSelect
            value={slot.startTime}
            min={c.startMin}
            max={c.startMax}
            onChange={(v) => updateSlot(slot.id, { startTime: v })}
          />
          <span className="slot-arrow">→</span>
          <TimeSelect
            value={slot.endTime}
            min={c.endMin}
            max={c.endMax}
            onChange={(v) => updateSlot(slot.id, { endTime: v })}
          />
          <select
            className="slot-scene"
            value={slot.sceneId}
            onChange={(e) => handleSceneChange(slot.id, e.target.value)}
          >
            <option value="off">🌑 Turn off</option>
            {scenes.map((s) => (
              <option key={s.id} value={s.id}>
                {sceneIcon(s.name)} {s.name}
              </option>
            ))}
          </select>
          <button className="slot-remove" onClick={() => removeSlot(slot.id)}>
            ✕
          </button>
        </div>
      )

      // Gap after this slot (to next slot, or to 23:55 for the last)
      const gapEnd = i < slots.length - 1 ? slots[i + 1].startTime : MAX_TIME
      if (toMin(slot.endTime) < toMin(gapEnd)) {
        items.push(
          <button
            key={`gap-${slot.id}`}
            className="slot-add-gap"
            onClick={() => addInGap(slot.endTime, gapEnd)}
          >
            + {slot.endTime} – {gapEnd}
          </button>
        )
      }
    })

    return items
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal__header">
          <h2 className="modal__title">⏰ {group.name}</h2>
          <button className="modal__close" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="modal__body">
          <div className="modal__enable-row">
            <span>Enable schedule</span>
            <button
              className={`toggle ${enabled ? 'toggle--on' : ''}`}
              onClick={() => setEnabled((e) => !e)}
            >
              <span className="toggle__track">
                <span className="toggle__thumb" />
              </span>
            </button>
          </div>

          <div className="slot-list">
            {slots.length === 0 ? (
              <p className="slot-empty">No time slots yet.</p>
            ) : (
              renderSlots()
            )}
          </div>

          {slots.length === 0 && (
            <button
              className="add-slot-btn"
              onClick={() => addInGap('00:00', MAX_TIME)}
            >
              + Add time slot
            </button>
          )}

          <div className="auto-off-section">
            <div className="modal__enable-row">
              <span>Auto-off after inactivity</span>
              <button
                className={`toggle ${autoOff.enabled ? 'toggle--on' : ''}`}
                onClick={() =>
                  setAutoOff((a) => ({ ...a, enabled: !a.enabled }))
                }
              >
                <span className="toggle__track">
                  <span className="toggle__thumb" />
                </span>
              </button>
            </div>

            {autoOff.enabled && (
              <div className="auto-off-row">
                <label className="auto-off-field">
                  <span>Sensor</span>
                  <select
                    value={autoOff.sensorId ?? ''}
                    onChange={(e) =>
                      setAutoOff((a) => ({
                        ...a,
                        sensorId: e.target.value || null
                      }))
                    }
                  >
                    <option value="">No sensor (timer only)</option>
                    {sensors.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="auto-off-field">
                  <span>After (minutes)</span>
                  <input
                    type="number"
                    min={1}
                    value={autoOff.timeoutMinutes}
                    onChange={(e) =>
                      setAutoOff((a) => ({
                        ...a,
                        timeoutMinutes: Math.max(1, Number(e.target.value) || 1)
                      }))
                    }
                  />
                </label>
              </div>
            )}
          </div>
        </div>

        <div className="modal__footer">
          <button className="modal-btn modal-btn--cancel" onClick={onClose}>
            Cancel
          </button>
          <button
            className="modal-btn modal-btn--save"
            onClick={handleSave}
            disabled={saving}
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}
