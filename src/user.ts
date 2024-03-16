import fetch from 'node-fetch'
import { cleanEnv, str } from 'envalid'
import { config } from 'dotenv'
import { appendFileSync, mkdirSync, existsSync, readFileSync } from 'fs'
import { OUTPUT_DIR } from './util'

config()

const { HUE_IP } = cleanEnv(process.env, {
  HUE_IP: str()
})

export const createUser = async () => {
  const response = await fetch(`http://${HUE_IP}/api`, {
    method: 'POST',
    body: JSON.stringify({ devicetype: 'my_hue_app#wsl kpc' })
  })
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
