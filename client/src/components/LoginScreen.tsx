import { useState, type FormEvent } from 'react'

interface Props {
  error?: boolean
  loading?: boolean
  onLogin: (username: string, password: string) => void
}

export function LoginScreen({ error, loading, onLogin }: Props) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault()
    if (username && password) onLogin(username, password)
  }

  return (
    <div className="setup-screen">
      <div className="setup-card">
        <span className="setup-card__icon">🔐</span>
        <h2 className="setup-card__title">Sign in</h2>
        <p className="setup-card__body">
          Enter a username and password from the server's <code>AUTH_USERS</code> setting.
        </p>
        <p className="setup-card__hint">
          If you haven't configured that yet, add{' '}
          <code>AUTH_USERS=username:password</code> to the server's{' '}
          <code>.env</code> and restart it — until then, every login attempt
          is rejected.
        </p>
        {error && (
          <div className="error-banner">
            Login rejected. Check the username and password against the
            server's <code>AUTH_USERS</code> setting.
          </div>
        )}
        <form className="connect-form connect-form--stacked" onSubmit={handleSubmit}>
          <input
            className="connect-form__input"
            type="text"
            placeholder="Username"
            value={username}
            onChange={e => setUsername(e.target.value)}
            disabled={loading}
            autoFocus
          />
          <input
            className="connect-form__input"
            type="password"
            placeholder="Password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            disabled={loading}
          />
          <button
            className="connect-form__submit"
            type="submit"
            disabled={!username || !password || loading}
          >
            {loading ? 'Signing in…' : 'Log in'}
          </button>
        </form>
      </div>
    </div>
  )
}
