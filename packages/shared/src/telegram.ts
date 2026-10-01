export type TelegramConnection =
  /** Started, not yet heard back from Telegram. */
  | 'starting'
  | 'ok'
  /** Telegram cannot be reached, or answered with an error; polling keeps retrying. */
  | 'unreachable'
  /** Not polling: never started, stopped, or the token was rejected (see `lastError`). */
  | 'stopped';

/** What the bridge itself knows; the app adds how the token is kept. */
export interface TelegramBridgeStatus {
  /** The bot's @username once Telegram has said what it is. */
  botUsername: string | null;
  /**
   * The one chat whose messages are acted on; null until the first one writes.
   *
   * The first private chat to message the bot is taken as the owner's and everything after is
   * measured against it. That is a deliberate trade for having no second step: see the note in
   * Settings about setting the token and messaging the bot straight away.
   */
  chatId: number | null;
  /** Who that chat belongs to, as Telegram names them. */
  chatName: string | null;
  connection: TelegramConnection;
  lastError: string | null;
  lastPolledAt: string | null;
  /** Messages from chats other than the paired one, dropped without a reply. */
  ignored: number;
}

/** The bridge's status plus what only the app knows: whether a token exists and how it is stored. */
export interface TelegramStatus extends TelegramBridgeStatus {
  configured: boolean;
  /** How the token is kept on disk; null when there is none. */
  storage: 'encrypted' | 'plain' | null;
}

export const NO_TELEGRAM: TelegramStatus = {
  botUsername: null,
  chatId: null,
  chatName: null,
  connection: 'stopped',
  lastError: null,
  lastPolledAt: null,
  ignored: 0,
  configured: false,
  storage: null,
};
