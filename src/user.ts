import { cleanEnv, str } from 'envalid'
import { config } from 'dotenv'
import { appendFileSync, mkdirSync, existsSync, readFileSync } from 'fs'
import { OUTPUT_DIR } from './util'
import { createBridgeAgent, DEFAULT_HUE_BRIDGE_ID } from '../server/bridgeTls'

config()

const { HUE_IP, HUE_BRIDGE_ID } = cleanEnv(process.env, {
  HUE_IP: str(),
  HUE_BRIDGE_ID: str({ default: DEFAULT_HUE_BRIDGE_ID })
})

export const createUser = async () => {
  const response = await fetch(`https://${HUE_IP}/api`, {
    method: 'POST',
    body: JSON.stringify({ devicetype: 'my_hue_app#ubuntu_kpc' }),
    dispatcher: createBridgeAgent({ bridgeId: HUE_BRIDGE_ID })
  } as RequestInit)
  const json = await response.json()
  console.log(json)

  if (Array.isArray(json)) {
    const error = json[0].error
    if (
      error &&
      error.type === 101 &&
      error.description === 'link button not pressed'
    ) {
      console.log(`press link button and run this script again`)
      process.exit(0)
    }

    const success = json[0].success
    if (success && success.username) {
      const username = success.username
      mkdirSync(OUTPUT_DIR, { recursive: true })
      appendFileSync(`${OUTPUT_DIR}/authenticated-users.txt`, `${username}\n`)
    }
  }
}

export const getUser = () => {
  const usersFile = `${OUTPUT_DIR}/authenticated-users.txt`
  if (!existsSync(usersFile)) {
    console.log(`no authenticated users found, create a user and try again`)
  }
  const users = readFileSync(usersFile).toString().split('\n')
  if (!Array.isArray(users)) {
    throw new Error('unexpected users format')
  }

  return users[0]
}
