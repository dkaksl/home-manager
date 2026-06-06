import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import path from 'path'
import {
  getEnrichedGroups,
  setGroupAction,
  activateScene,
  activateSmartScene
} from './hue'

const SCHEDULES_FILE = path.join(process.cwd(), 'data', 'schedules.json')

export interface TimeSlot {
  id: string
  startTime: string // "HH:MM"
  endTime: string // "HH:MM" exclusive
  sceneId: string // scene id, or 'off'
  sceneType: 'static' | 'smart' | 'off'
}

export interface RoomSchedule {
  groupId: string
  enabled: boolean
  slots: TimeSlot[]
}

const load = (): Record<string, RoomSchedule> => {
  if (!existsSync(SCHEDULES_FILE)) return {}
  try {
    return JSON.parse(readFileSync(SCHEDULES_FILE, 'utf8'))
  } catch {
    return {}
  }
}

const persist = (data: Record<string, RoomSchedule>) => {
  mkdirSync(path.dirname(SCHEDULES_FILE), { recursive: true })
  writeFileSync(SCHEDULES_FILE, JSON.stringify(data, null, 2))
}

export const getSchedules = () => load()

export const setSchedule = (groupId: string, schedule: RoomSchedule) => {
  const data = load()
  data[groupId] = { ...schedule, groupId }
  persist(data)
}

const toMin = (hhmm: string): number => {
  const [h, m] = hhmm.split(':').map(Number)
  return h * 60 + m
}

const inSlot = (nowMin: number, slot: TimeSlot): boolean => {
  const s = toMin(slot.startTime)
  const e = toMin(slot.endTime)
  // Handle midnight-crossing slots (e.g. 23:00 → 01:00)
  return s <= e ? nowMin >= s && nowMin < e : nowMin >= s || nowMin < e
}

const tick = async () => {
  const data = load()
  const enabled = Object.values(data).filter(
    (s) => s.enabled && s.slots.length > 0
  )
  if (!enabled.length) return

  const now = new Date()
  const nowMin = now.getHours() * 60 + now.getMinutes()

  // Fetch group states once, only when needed for scene slots
  let groups: Awaited<ReturnType<typeof getEnrichedGroups>> | null = null

  for (const schedule of enabled) {
    const slot = schedule.slots.find((s) => inSlot(nowMin, s))
    if (!slot) continue

    try {
      if (slot.sceneType === 'off') {
        await setGroupAction(schedule.groupId, { on: false })
      } else {
        if (!groups) groups = await getEnrichedGroups()
        const group = groups.find((g) => g.id === schedule.groupId)
        if (!group?.state.any_on) continue

        if (slot.sceneType === 'smart') {
          await activateSmartScene(slot.sceneId)
        } else {
          await activateScene(schedule.groupId, slot.sceneId)
        }
      }
    } catch (err) {
      console.error(`[scheduler] group ${schedule.groupId}:`, err)
    }
  }
}

export const startScheduler = () => {
  // Align first tick to the next whole minute, then every 60s
  const msToNextMinute =
    (60 - new Date().getSeconds()) * 1000 - new Date().getMilliseconds()

  setTimeout(() => {
    tick()
    setInterval(tick, 60_000)
  }, msToNextMinute)

  console.log(
    `[scheduler] starting, first tick in ${Math.round(msToNextMinute / 1000)}s`
  )
}
