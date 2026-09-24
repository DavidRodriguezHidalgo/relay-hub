import type { Theme } from './theme';

interface Props {
  theme: Theme;
  onTheme: (theme: Theme) => void;
  allowAllActions: boolean;
  onAllowAllActions: (on: boolean) => void;
  /** Why the last change did not take, when it did not. */
  error: string | null;
  onClose: () => void;
}

export function Settings(p: Props) {
  return (
    <div className="settings-backdrop" onClick={p.onClose}>
      <div className="settings" role="dialog" aria-label="Settings" onClick={(e) => e.stopPropagation()}>
        <header className="settings__header">
          <h2>Settings</h2>
          <button type="button" onClick={p.onClose}>
            Close
          </button>
        </header>

        {p.error && (
          <p role="alert" className="error">
            {p.error}
          </p>
        )}

        <section className="settings__section">
          <h3>Appearance</h3>
          {(['dark', 'light'] as const).map((t) => (
            <label key={t} className="settings__row">
              <input type="radio" name="theme" checked={p.theme === t} onChange={() => p.onTheme(t)} />
              {t === 'dark' ? 'Dark' : 'Light'}
            </label>
          ))}
        </section>

        <section className="settings__section">
          <h3>Actions</h3>
          <label className="settings__row">
            <input
              type="checkbox"
              checked={p.allowAllActions}
              onChange={(e) => p.onAllowAllActions(e.target.checked)}
            />
            Allow all actions without asking
          </label>
          <p className="settings__note">
            Sessions Relay drives will run everything, including destructive commands and work outside their own
            folder, without stopping for you. It does not change a session you run yourself in a terminal, does not
            override a session’s own settings, and take-over and bulk runs are still confirmed. It applies to every
            session Relay drives.
          </p>
        </section>
      </div>
    </div>
  );
}
