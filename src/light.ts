import { cleanEnv, str } from 'envalid'
import { config } from 'dotenv'

config()

const { HUE_IP } = cleanEnv(process.env, {
  HUE_IP: str()
})

export const setLight = async (
  user: string,
  lightId: number,
  lightProps: { on: boolean; bri?: number; hue?: number; sat?: number }
) => {
  const response = await fetch(
    `http://${HUE_IP}/api/${user}/lights/${lightId}/state`,
    { method: 'put', body: JSON.stringify(lightProps) }
  )
  const json = await response.json()

  if (Array.isArray(json)) {
    const error = json[0].error
    if (
      error &&
      error.type === 1 &&
      error.description === 'unauthorized user'
    ) {
      console.log(`invalid username ${user}`)
      process.exit(1)
    }
  }
  return json
}
