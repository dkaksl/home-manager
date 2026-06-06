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
