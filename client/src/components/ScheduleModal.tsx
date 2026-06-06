import { useState } from 'react'
import type { Group, Scene, TimeSlot, RoomSchedule } from '../types'

interface Props {
  group: Group
  scenes: Scene[]
  initialSchedule: RoomSchedule | undefined
  onClose: () => void
  onSave: (schedule: RoomSchedule) => Promise<void>
}

const newSlot = (): TimeSlot => ({
  id: crypto.randomUUID(),
  startTime: '20:00',
  endTime: '22:00',
  sceneId: 'off',
  sceneType: 'off'
})

export function ScheduleModal({ group, scenes, initialSchedule, onClose, onSave }: Props) {
  const [enabled, setEnabled] = useState(initialSchedule?.enabled ?? false)
  const [slots, setSlots] = useState<TimeSlot[]>(initialSchedule?.slots ?? [])
  const [saving, setSaving] = useState(false)

  const removeSlot = (id: string) =>
    setSlots(s => s.filter(sl => sl.id !== id))

  const updateSlot = (id: string, changes: Partial<TimeSlot>) =>
    setSlots(s => s.map(sl => sl.id === id ? { ...sl, ...changes } : sl))

  const handleSceneChange = (slotId: string, sceneId: string) => {
    if (sceneId === 'off') {
      updateSlot(slotId, { sceneId: 'off', sceneType: 'off' })
    } else {
      const scene = scenes.find(s => s.id === sceneId)
      updateSlot(slotId, { sceneId, sceneType: scene?.type ?? 'static' })
    }
  }

  const handleSave = async () => {
    setSaving(true)
    try {
      await onSave({ groupId: group.id, enabled, slots })
      onClose()
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal__header">
          <h2 className="modal__title">⏰ {group.name}</h2>
          <button className="modal__close" onClick={onClose}>✕</button>
        </div>

        <div className="modal__body">
          <div className="modal__enable-row">
            <span>Enable schedule</span>
            <button
              className={`toggle ${enabled ? 'toggle--on' : ''}`}
              onClick={() => setEnabled(e => !e)}
            >
              <span className="toggle__track">
                <span className="toggle__thumb" />
              </span>
            </button>
          </div>

          <div className="slot-list">
            {slots.length === 0 && (
              <p className="slot-empty">No time slots yet.</p>
            )}
            {slots.map(slot => (
              <div key={slot.id} className="slot-row">
                <input
                  type="time"
                  className="slot-time"
                  value={slot.startTime}
                  onChange={e => updateSlot(slot.id, { startTime: e.target.value })}
                />
                <span className="slot-arrow">→</span>
                <input
                  type="time"
                  className="slot-time"
                  value={slot.endTime}
                  onChange={e => updateSlot(slot.id, { endTime: e.target.value })}
                />
                <select
                  className="slot-scene"
                  value={slot.sceneId}
                  onChange={e => handleSceneChange(slot.id, e.target.value)}
                >
                  <option value="off">Turn off</option>
                  {scenes.map(s => (
                    <option key={s.id} value={s.id}>{s.name}</option>
                  ))}
                </select>
                <button className="slot-remove" onClick={() => removeSlot(slot.id)}>✕</button>
              </div>
            ))}
          </div>

          <button className="add-slot-btn" onClick={() => setSlots(s => [...s, newSlot()])}>
            + Add time slot
          </button>
        </div>

        <div className="modal__footer">
          <button className="modal-btn modal-btn--cancel" onClick={onClose}>Cancel</button>
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
