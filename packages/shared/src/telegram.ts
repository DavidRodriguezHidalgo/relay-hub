/** A Telegram chat that messaged the bot while no chat was paired; shown in Settings for the user to accept. */
export interface TelegramCandidate {
  chatId: number;
  /** The sender as Telegram names them: first and last name, or @username. */
  name: string;
  at: string;
}

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
  /** The one chat whose messages are acted on; null while unpaired. */
  chatId: number | null;
  candidate: TelegramCandidate | null;
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
  /** The paired chat's owner, as recorded when it was paired. */
  chatName: string | null;
}

export const NO_TELEGRAM: TelegramStatus = {
  botUsername: null,
  chatId: null,
  candidate: null,
  connection: 'stopped',
  lastError: null,
  lastPolledAt: null,
  ignored: 0,
  configured: false,
  storage: null,
  chatName: null,
};
