export interface LightState {
  on: boolean
  bri?: number
  hue?: number
  sat?: number
  ct?: number
  colormode?: string
  reachable: boolean
}

export interface Light {
  id: string
  name: string
  type: string
  state: LightState
  manufacturername: string
  productname: string
  modelid: string
}

export interface Scene {
  id: string
  name: string
  group: string
  type: 'static' | 'smart'
}

export interface TimeSlot {
  id: string
  startTime: string
  endTime: string
  sceneId: string
  sceneType: 'static' | 'smart' | 'off'
}

export interface AutoOffConfig {
  enabled: boolean
  timeoutMinutes: number
  sensorId: string | null // null = plain timer (off N min after the room turns on)
}

export interface RoomSchedule {
  groupId: string
  enabled: boolean
  slots: TimeSlot[]
  killSwitch?: boolean
  autoOff?: AutoOffConfig
}

export interface Sensor {
  id: string
  name: string
  presence: boolean
  lastupdated: string
}

export interface GroupState {
  all_on: boolean
  any_on: boolean
}

export interface Group {
  id: string
  name: string
  type: string
  class: string
  lights: string[]
  state: GroupState
  lightDetails: Light[]
}
