import type { CheckoutPlan, CheckoutResult, UpdateCheck, UpdateMode } from '@relay/shared';
import type { Theme } from './theme';

interface Props {
  theme: Theme;
  onTheme: (theme: Theme) => void;
  allowAllActions: boolean;
  onAllowAllActions: (on: boolean) => void;
  /** Why the last change did not take, when it did not. */
  error: string | null;
  onClose: () => void;
  /** The last update check, or null before one has run. */
  update: UpdateCheck | null;
  checkingUpdate: boolean;
  onCheckForUpdate: () => void;
  /** Where the downloaded build landed, once it has been fetched. */
  downloadedTo: string | null;
  downloading: boolean;
  downloadError: string | null;
  onDownloadUpdate: () => void;
  /** How this copy updates; the other path is not offered. */
  updateMode: UpdateMode;
  checkoutPlan: CheckoutPlan | null;
  checkoutResult: CheckoutResult | null;
  pulling: boolean;
  onPull: () => void;
}

/** One line saying where the app stands against its releases. */
function updateLine(u: UpdateCheck): string {
  if (u.error) return `Couldn’t check: ${u.error}`;
  if (u.latest === null) return 'No release has been published yet.';
  if (u.newer) return `Version ${u.latest} is available.`;
  return `You’re up to date (${u.latest} is the newest release).`;
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
        <section className="settings__section">
          <h3>About</h3>
          <p className="settings__row">
            Relay Hub {p.update ? p.update.current : ''}
            <button type="button" disabled={p.checkingUpdate} onClick={p.onCheckForUpdate}>
              {p.checkingUpdate ? 'Checking…' : 'Check for updates'}
            </button>
          </p>
          {p.update && (
            <p role="status" className="settings__note">
              {updateLine(p.update)}
              {p.update.newer && p.update.url && (
                <>
                  {' '}
                  <a href={p.update.url} target="_blank" rel="noreferrer">
                    Open the release
                  </a>
                </>
              )}
            </p>
          )}
          {p.update?.newer && p.update.notes && <pre className="settings__notes">{p.update.notes}</pre>}
          {p.updateMode === 'checkout' && p.checkoutPlan && (
            <div className="settings__update">
              {p.checkoutPlan.kind === 'up-to-date' && (
                <span className="settings__note">This working copy is level with {p.checkoutPlan.upstream}.</span>
              )}
              {p.checkoutPlan.kind === 'refused' && (
                <p role="alert" className="error">
                  {p.checkoutPlan.reason}
                </p>
              )}
              {p.checkoutPlan.kind === 'ready' && (
                <>
                  <p className="settings__note">
                    {p.checkoutPlan.commits.length} commit{p.checkoutPlan.commits.length === 1 ? '' : 's'} to pull from{' '}
                    {p.checkoutPlan.upstream} into {p.checkoutPlan.branch}
                    {p.checkoutPlan.needsInstall ? ', and the dependencies will be installed again' : ''}.
                  </p>
                  <ul className="settings__commits">
                    {p.checkoutPlan.commits.map((c) => (
                      <li key={c.sha}>
                        <code>{c.sha.slice(0, 7)}</code> {c.subject}
                      </li>
                    ))}
                  </ul>
                  <button type="button" disabled={p.pulling} onClick={p.onPull}>
                    {p.pulling ? 'Pulling…' : 'Pull and update this working copy'}
                  </button>
                </>
              )}
              {p.checkoutResult && (
                <p role="status" className="settings__note">
                  Pulled {p.checkoutResult.pulled.length} commit
                  {p.checkoutResult.pulled.length === 1 ? '' : 's'}
                  {p.checkoutResult.installed ? ' and installed the dependencies' : ''}. Restart Relay to run it.
                </p>
              )}
              {p.checkoutResult?.error && (
                <p role="alert" className="error">
                  {p.checkoutResult.error}
                </p>
              )}
            </div>
          )}
          {p.updateMode === 'packaged' && p.update?.newer && (
            <div className="settings__update">
              {p.update.assetUrl ? (
                <button type="button" disabled={p.downloading} onClick={p.onDownloadUpdate}>
                  {p.downloading ? 'Downloading\u2026' : 'Download the new version'}
                </button>
              ) : (
                <span className="settings__note">That release has no build attached to download.</span>
              )}
              {p.downloadedTo && (
                <p role="status" className="settings__note">
                  Downloaded to {p.downloadedTo} and shown in Finder. Quit Relay, drag the new app over the old
                  one, and open it again — an unsigned app cannot replace itself while running.
                </p>
              )}
              {p.downloadError && (
                <p role="alert" className="error">
                  {p.downloadError}
                </p>
              )}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
