import fetch from 'node-fetch'
import { cleanEnv, str } from 'envalid'
import { config } from 'dotenv'
import { getUser } from './user'
import { OUTPUT_DIR } from './util'
import { writeFileSync } from 'fs'

config()

const { HUE_IP } = cleanEnv(process.env, {
  HUE_IP: str()
})

export const getFullDetails = async (user: string) => {
  const response = await fetch(`http://${HUE_IP}/api/${user}`)
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

  writeFileSync(
    `${OUTPUT_DIR}/bridge-details.json`,
    JSON.stringify(json, null, 2)
  )
  return json
}

export const fetchBridgeDetails = async () => {
  const user = getUser()
  const full = await getFullDetails(user)
  return full
}
