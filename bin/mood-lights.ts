import { getFullDetails } from '../src/bridge'
import { setLight } from '../src/light'
import { getUser } from '../src/user'

const isLaterThanTime = (h: number, m: number) => {
  const now = new Date()
  const time = new Date()
  time.setHours(h)
  time.setMinutes(m)
  return now.getTime() > time.getTime()
}

const isLate = () => isLaterThanTime(20, 0)

const isNight = () => isLaterThanTime(21, 30)

const setLightScenes = async () => {
  const user = getUser()

  const bridgeDetails = await getFullDetails(user)
  const { lights, groups } = bridgeDetails
  for (const [, l] of Object.entries(lights)) {
    console.log((l as any).type)
  }
  // TODO: handle lights that appear in multiple groups
  for (const [, g] of Object.entries(groups)) {
    const group = g as any
    const { name, lights: groupLights } = group
    console.log(`group ${name} has lights ${groupLights}`)
    groupLights.forEach(async (id: number) => {
      const { state, type } = lights[id]
      const { on, reachable } = state
      console.log(`light ${id} is on? ${on} and reachable? ${reachable}`)
      // TODO: expand to all rooms once tested
      if (name === 'Kontoret') {
        // TODO: skip lights which are already properly configured?
        if (on) {
          if (isNight()) {
            await setLight(user, id, {
              on,
              bri: type === 'Extended color light' ? 25 : 1
            })
          } else if (isLate()) {
            await setLight(user, id, { on, bri: 89 })
          }
        }
      }
    })
  }
}

setLightScenes().then(() => {
  console.log('done')
})
