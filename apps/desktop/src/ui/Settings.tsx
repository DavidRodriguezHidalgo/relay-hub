import type { CheckoutPlan, CheckoutResult, TelegramStatus, UpdateCheck, UpdateMode } from '@relay/shared';
import { modelLabel, newSessionModelSentence, type ModelChoice, type NewSessionModel } from '@relay/shared';
import { useState } from 'react';
import type { AccountUsage } from '@relay/shared';
import { UsageTab } from './UsageTab';
import type { Theme } from './theme';
import { checkoutStanding } from './checkoutStanding';
import { TelegramSettings } from './TelegramSettings';

interface Props {
  theme: Theme;
  onTheme: (theme: Theme) => void;
  allowAllActions: boolean;
  onAllowAllActions: (on: boolean) => void;
  crashReports: boolean;
  onCrashReports: (on: boolean) => void;
  /** What a new session will run on, or null before it has been looked up. */
  newSessionModel: NewSessionModel | null;
  onNewSessionModel: (model: string) => void;
  /** What Claude Code would pick on its own, and where that is saved. */
  claudeDefaultModel: string | null;
  claudeSettingsPath: string;
  /** Models a new session could run on; empty until they have been asked for. */
  models: ModelChoice[];
  /** Which tab to open on; the usage pill in the title strip opens straight onto Usage. */
  initialTab?: 'general' | 'usage' | 'about';
  usage: AccountUsage | null;
  now: Date;
  onRefreshUsage: () => void;
  refreshingUsage: boolean;
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
  /** Everything the Telegram section needs; it renders itself from this. */
  telegram: TelegramStatus;
  telegramBusy: boolean;
  telegramError: string | null;
  telegramTestSent: boolean;
  onTelegramToken: (token: string | null) => void;
  onTelegramUnpair: () => void;
  onTelegramTest: () => void;
}

/** One line saying where the app stands against its releases. */
function updateLine(u: UpdateCheck): string {
  if (u.error) return `Couldn’t check: ${u.error}`;
  if (u.latest === null) return 'No release has been published yet.';
  if (u.newer) return `Version ${u.latest} is available.`;
  return `You’re up to date (${u.latest} is the newest release).`;
}

/** Three, so Settings has structure without becoming somewhere you have to navigate. */
const TABS = [
  { id: 'general', label: 'General' },
  { id: 'usage', label: 'Usage' },
  { id: 'about', label: 'About' },
] as const;

export type SettingsTab = (typeof TABS)[number]['id'];

export function Settings(p: Props) {
  const [tab, setTab] = useState<SettingsTab>(p.initialTab ?? 'general');
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

        <nav className="settings__tabs" role="tablist" aria-label="Settings sections">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              id={`settings-tab-${t.id}`}
              aria-selected={tab === t.id}
              aria-controls={`settings-panel-${t.id}`}
              className={tab === t.id ? 'settings__tab settings__tab--on' : 'settings__tab'}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </nav>

        <div role="tabpanel" id="settings-panel-general" aria-labelledby="settings-tab-general" hidden={tab !== 'general'}>
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
        <TelegramSettings
          status={p.telegram}
          busy={p.telegramBusy}
          error={p.telegramError}
          testSent={p.telegramTestSent}
          onSaveToken={(token) => p.onTelegramToken(token)}
          onRemoveToken={() => p.onTelegramToken(null)}
          onUnpair={p.onTelegramUnpair}
          onTest={p.onTelegramTest}
        />
        <section className="settings__section">
          <h3>New sessions</h3>
          <label className="settings__row">
            Model
            <select
              aria-label="Model for new sessions"
              value={p.newSessionModel?.id ?? ''}
              onChange={(e) => p.onNewSessionModel(e.target.value)}
            >
              {/* a stored choice the list no longer offers matches no option; without this the
                  select would show nothing while the note underneath names a model */}
              {!p.models.some((m) => m.id === p.newSessionModel?.id) && <option value="">—</option>}
              {p.models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </label>
          <p className="settings__note">{newSessionModelSentence(p.newSessionModel)}</p>
          <p className="settings__note">
            {p.claudeDefaultModel
              ? `Relay asks for this model by name every time it starts a session. Your own saved default (${modelLabel(
                  p.claudeDefaultModel,
                )}, in ${p.claudeSettingsPath}) is left to the sessions you start yourself — Relay does not use it and never writes to that file.`
              : `Relay asks for this model by name every time it starts a session, so nothing it starts depends on the saved default in ${p.claudeSettingsPath}. Relay never writes to that file.`}
          </p>
        </section>
        <section className="settings__section">
          <h3>Crash reports</h3>
          <label className="settings__row">
            <input type="checkbox" checked={p.crashReports} onChange={(e) => p.onCrashReports(e.target.checked)} />
            Send crash reports
          </label>
          <p className="settings__note">
            A report says what failed and where in Relay it happened. File paths, branch names and session titles are
            removed first, and nothing from your conversations is included. This takes effect the next time Relay
            starts, and a copy run from a checkout never reports at all.
          </p>
        </section>
        </div>

        <div role="tabpanel" id="settings-panel-usage" aria-labelledby="settings-tab-usage" hidden={tab !== 'usage'}>
          <UsageTab usage={p.usage} now={p.now} onRefresh={p.onRefreshUsage} refreshing={p.refreshingUsage} />
        </div>

        <div role="tabpanel" id="settings-panel-about" aria-labelledby="settings-tab-about" hidden={tab !== 'about'}>
        <section className="settings__section">
          <h3>About</h3>
          <p className="settings__row">
            Relay Hub {p.update ? p.update.current : ''}
            <span className="settings__build">
              {p.updateMode === 'checkout' ? 'running from a checkout' : 'installed build'}
            </span>
            <button type="button" disabled={p.checkingUpdate} onClick={p.onCheckForUpdate}>
              {p.checkingUpdate ? 'Checking…' : 'Check for updates'}
            </button>
          </p>
          {p.updateMode === 'checkout' && (
            <p className="settings__note">
              A checkout also gives each session its own message box and its “/” menu. An installed build
              does not: sessions are driven from the Relay chat there.
            </p>
          )}
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
          {p.updateMode === 'checkout' && checkoutStanding(p.checkoutPlan) && (
            <p className={`settings__standing settings__standing--${checkoutStanding(p.checkoutPlan)!.kind}`}>
              {checkoutStanding(p.checkoutPlan)!.message}
            </p>
          )}
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
    </div>
  );
}