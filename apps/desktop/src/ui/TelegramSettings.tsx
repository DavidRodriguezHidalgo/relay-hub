import { useState } from 'react';
import type { TelegramStatus } from '@relay/shared';

interface Props {
  status: TelegramStatus;
  /** A change is in flight; the controls are held rather than clicked twice. */
  busy: boolean;
  /** Why the last change did not take, when it did not. */
  error: string | null;
  testSent: boolean;
  onSaveToken: (token: string) => void;
  onRemoveToken: () => void;
  onUnpair: () => void;
  onTest: () => void;
}

/** One line about the connection, or null while there is nothing to say. */
function connectionLine(s: TelegramStatus): { text: string; bad: boolean } | null {
  if (s.connection === 'unreachable') return { text: `Cannot reach Telegram: ${s.lastError ?? 'unknown problem'}. Relay keeps trying.`, bad: true };
  if (s.connection === 'stopped' && s.lastError) return { text: s.lastError, bad: true };
  if (s.connection === 'starting') return { text: 'Connecting…', bad: false };
  if (s.connection === 'ok') return { text: 'Connected.', bad: false };
  return null;
}

/**
 * Setting up the phone bridge.
 *
 * Deliberately the whole story in one place: what to do first, what it is doing now, and what
 * a phone is and is not allowed to do — the last matters because approvals arrive there.
 */
export function TelegramSettings(p: Props) {
  const [token, setToken] = useState('');
  const s = p.status;
  const line = connectionLine(s);
  /** Stopped with a reason means nothing is polling: saying what to do next would be a lie. */
  const dead = s.connection === 'stopped' && s.lastError !== null;

  return (
    <section className="settings__section" aria-label="Telegram">
      <h3>Telegram</h3>
      <p className="settings__note">
        Message Relay from your phone. Your Mac polls Telegram, so nothing of yours is exposed to the internet and it
        works from any network.
      </p>

      {p.error && (
        <p role="alert" className="error">
          {p.error}
        </p>
      )}

      {!s.configured && (
        <>
          <ol className="settings__steps">
            <li>In Telegram, open a chat with @BotFather.</li>
            <li>Send /newbot and follow the two questions (a name, then a username ending in “bot”).</li>
            <li>BotFather replies with a token — paste the token below and save it.</li>
            <li>Message your new bot from your phone. That chat becomes yours; nothing else is needed.</li>
          </ol>
          <label className="settings__row">
            Bot token
            <input
              type="password"
              value={token}
              autoComplete="off"
              spellCheck={false}
              placeholder="123456789:AA…"
              onChange={(e) => setToken(e.target.value)}
            />
          </label>
          <button type="button" disabled={p.busy || token.trim() === ''} onClick={() => p.onSaveToken(token.trim())}>
            Save token
          </button>
          <p className="settings__note">
            The token is kept in your Mac’s keychain, never in the repository. Anyone who gets it can read what you
            send the bot and send you messages as the bot. They could also claim the bot by writing to it before you
            do, which is why you should message it as soon as you save the token.
          </p>
        </>
      )}

      {s.configured && (
        <>
          {(s.botUsername || !dead) && (
            <p className="settings__row">{s.botUsername ? `@${s.botUsername}` : 'Asking Telegram which bot this is…'}</p>
          )}
          {line && <p className={line.bad ? 'error' : 'settings__note'} role={line.bad ? 'alert' : undefined}>{line.text}</p>}

          {dead ? null : s.chatId === null ? (
            <p className="settings__note">
              Now message {s.botUsername ? `@${s.botUsername}` : 'your bot'} from your phone. The first chat to write
              becomes yours, and every other chat is ignored from then on — so do it now rather than later, while only
              you know the bot is there.
            </p>
          ) : (
            <>
              <p className="settings__row">
                Paired with {s.chatName ?? 'your phone'} (chat {s.chatId}).
                <button type="button" disabled={p.busy} onClick={p.onUnpair}>
                  Unpair
                </button>
              </p>
              <p className="settings__row">
                <button type="button" disabled={p.busy} onClick={p.onTest}>
                  Send test message
                </button>
                {p.testSent && (
                  <span role="status" className="settings__note">
                    Sent — check your phone.
                  </span>
                )}
              </p>
              <p className="settings__note">
                Approvals reach your phone. Denying always works; allowing is offered only for a rebase, an amend or a
                force-push with a lease. Anything that deletes files or can overwrite work you have not seen waits for
                you here.
              </p>
            </>
          )}

          {s.ignored > 0 && (
            <p className="settings__note">
              {s.ignored} message{s.ignored === 1 ? '' : 's'} from other chats {s.ignored === 1 ? 'was' : 'were'} ignored.
            </p>
          )}
          {s.storage === 'plain' && (
            <p className="settings__note">
              The token could not be encrypted on this machine, so it is stored as plain text in Relay’s data folder.
            </p>
          )}
          <button type="button" disabled={p.busy} onClick={p.onRemoveToken}>
            Remove token
          </button>
        </>
      )}
    </section>
  );
}
