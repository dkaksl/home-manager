const HOST_STORAGE_KEY = 'hue-manager.server-host'
const CREDENTIALS_STORAGE_KEY = 'hue-manager.credentials'

export const loadStoredHost = (): string | null => localStorage.getItem(HOST_STORAGE_KEY)

export const storeHost = (host: string): void => {
  localStorage.setItem(HOST_STORAGE_KEY, host)
}

export const clearStoredHost = (): void => {
  localStorage.removeItem(HOST_STORAGE_KEY)
}

export const apiUrl = (path: string): string => {
  const host = loadStoredHost()
  if (!host) throw new Error('Server host is not configured')
  const origin = /^https?:\/\//i.test(host) ? host : `http://${host}`
  return `${origin}${path}`
}

export interface Credentials {
  username: string
  password: string
}

export const loadStoredCredentials = (): Credentials | null => {
  const raw = localStorage.getItem(CREDENTIALS_STORAGE_KEY)
  if (!raw) return null
  try {
    return JSON.parse(raw) as Credentials
  } catch {
    return null
  }
}

export const storeCredentials = (credentials: Credentials): void => {
  localStorage.setItem(CREDENTIALS_STORAGE_KEY, JSON.stringify(credentials))
}

export const clearStoredCredentials = (): void => {
  localStorage.removeItem(CREDENTIALS_STORAGE_KEY)
}

export const authHeaders = (): Record<string, string> => {
  const credentials = loadStoredCredentials()
  if (!credentials) return {}
  return { Authorization: `Basic ${btoa(`${credentials.username}:${credentials.password}`)}` }
}
