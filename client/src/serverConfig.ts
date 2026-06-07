const STORAGE_KEY = 'hue-manager.server-host'

export const loadStoredHost = (): string | null => localStorage.getItem(STORAGE_KEY)

export const storeHost = (host: string): void => {
  localStorage.setItem(STORAGE_KEY, host)
}

export const clearStoredHost = (): void => {
  localStorage.removeItem(STORAGE_KEY)
}

export const apiUrl = (path: string): string => {
  const host = loadStoredHost()
  if (!host) throw new Error('Server host is not configured')
  const origin = /^https?:\/\//i.test(host) ? host : `http://${host}`
  return `${origin}${path}`
}
