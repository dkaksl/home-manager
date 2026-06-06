import type { ApiErrorCode } from '../api'

interface Props {
  reason: ApiErrorCode
}

export function SetupScreen({ reason }: Props) {
  return (
    <div className="setup-screen">
      <div className="setup-card">
        <span className="setup-card__icon">🔌</span>
        {reason === 'not_configured' ? (
          <>
            <h2 className="setup-card__title">Bridge not configured</h2>
            <p className="setup-card__body">
              Add your Hue application key to the server environment:
            </p>
            <pre className="setup-card__code">HUE_USER=&lt;your-token&gt;</pre>
            <p className="setup-card__hint">
              You can find or create a token in the Hue developer portal, or by
              running the <code>createUser</code> script in this repo.
            </p>
          </>
        ) : reason === 'unauthorized' ? (
          <>
            <h2 className="setup-card__title">Bridge rejected credentials</h2>
            <p className="setup-card__body">
              The bridge at <code>{window.location.hostname}</code> did not
              accept the <code>HUE_USER</code> token in your <code>.env</code>.
            </p>
            <p className="setup-card__hint">
              Double-check the value, or create a new user by pressing the link
              button on the bridge and running the <code>createUser</code> script.
            </p>
          </>
        ) : (
          <>
            <h2 className="setup-card__title">Something went wrong</h2>
            <p className="setup-card__body">
              The server returned an unexpected error. Check the server logs for details.
            </p>
          </>
        )}
      </div>
    </div>
  )
}
