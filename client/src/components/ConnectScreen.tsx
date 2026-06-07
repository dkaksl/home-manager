import { useState, type FormEvent } from 'react'

interface Props {
  onConnect: (host: string) => void
}

export function ConnectScreen({ onConnect }: Props) {
  const [host, setHost] = useState('')

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault()
    const trimmed = host.trim()
    if (trimmed) onConnect(trimmed)
  }

  return (
    <div className="setup-screen">
      <div className="setup-card">
        <span className="setup-card__icon">🔗</span>
        <h2 className="setup-card__title">Connect to server</h2>
        <p className="setup-card__body">
          Enter the hostname or IP address (and optional port) where the Hue
          Manager server is running.
        </p>
        <form className="connect-form" onSubmit={handleSubmit}>
          <input
            className="connect-form__input"
            type="text"
            placeholder="192.168.1.50:3001"
            value={host}
            onChange={e => setHost(e.target.value)}
            autoFocus
          />
          <button
            className="connect-form__submit"
            type="submit"
            disabled={!host.trim()}
          >
            Connect
          </button>
        </form>
        <p className="setup-card__hint">
          This is stored in your browser and can be changed later from the
          header.
        </p>
      </div>
    </div>
  )
}
