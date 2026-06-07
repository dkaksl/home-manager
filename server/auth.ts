import type { NextFunction, Request, Response } from 'express'

// AUTH_USERS is a comma-separated list of "username:password" pairs
const parseUsers = (raw: string): Record<string, string> =>
  Object.fromEntries(
    raw
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => {
        const sep = entry.indexOf(':')
        return [entry.slice(0, sep), entry.slice(sep + 1)]
      })
  )

const users = parseUsers(process.env.AUTH_USERS ?? '')

if (Object.keys(users).length === 0) {
  console.warn('AUTH_USERS is not set — all API requests will be rejected. Set AUTH_USERS=username:password in .env to allow access.')
}

const challenge = (res: Response) => {
  res.set('WWW-Authenticate', 'Basic realm="Hue Manager"')
  res.status(401).json({ error: 'unauthorized' })
}

export const requireAuth = (req: Request, res: Response, next: NextFunction) => {
  const [scheme, encoded] = (req.headers.authorization ?? '').split(' ')
  if (scheme !== 'Basic' || !encoded) return challenge(res)

  const decoded = Buffer.from(encoded, 'base64').toString('utf-8')
  const sep = decoded.indexOf(':')
  const username = decoded.slice(0, sep)
  const password = decoded.slice(sep + 1)

  if (users[username] !== password) return challenge(res)

  next()
}
