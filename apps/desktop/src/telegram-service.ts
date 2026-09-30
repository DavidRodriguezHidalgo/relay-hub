import { NO_TELEGRAM, type TelegramBridgeStatus, type TelegramStatus } from '@relay/shared';
import { readTelegramConfig, validTokenShape, writeTelegramConfig, type SafeStorage } from './telegram-config';

/** The part of the engine this service drives; narrow so a test needs no engine. */
export interface TelegramCapableEngine {
  startTelegram(opts: { token: string; chatId: number | null }): TelegramBridgeStatus;
  stopTelegram(): void;
  telegramStatus(): TelegramBridgeStatus;
  telegramTest(): Promise<void>;
}

/**
 * Owns the bot token and decides when the engine's bridge runs.
 *
 * The split matters: the engine can drive a Telegram chat but has nowhere to keep a secret,
 * and this has the secret but knows nothing about chats. Neither does anything at all until a
 * token is saved, which is what keeps an unconfigured copy of Relay completely quiet.
 */
export class TelegramService {
  /** Why the last start failed, if it did; the bridge cannot report what it never got to run. */
  private startError: string | null = null;

  constructor(
    private readonly engine: TelegramCapableEngine,
    private readonly userDataDir: string,
    private readonly safeStorage: SafeStorage,
  ) {}

  /** Called at startup: starts the bridge if a token was saved, and does nothing at all if not. */
  async startIfConfigured(): Promise<void> {
    const config = await readTelegramConfig(this.userDataDir, this.safeStorage);
    if (!config) return;
    this.start(config.token, config.chatId);
  }

  async status(): Promise<TelegramStatus> {
    const config = await readTelegramConfig(this.userDataDir, this.safeStorage);
    if (!config) return { ...NO_TELEGRAM };
    const bridge = this.engine.telegramStatus();
    return {
      ...bridge,
      ...(this.startError ? { connection: 'stopped' as const, lastError: this.startError } : {}),
      configured: true,
      storage: config.storage,
      chatName: config.chatName,
    };
  }

  /** Saves a token and starts polling unpaired; `null` removes it and stops. */
  async setToken(token: string | null): Promise<TelegramStatus> {
    if (token === null) {
      await writeTelegramConfig(this.userDataDir, null, this.safeStorage);
      this.engine.stopTelegram();
      return { ...NO_TELEGRAM };
    }
    const trimmed = token.trim();
    if (!validTokenShape(trimmed)) {
      throw new Error('That does not look like a bot token. BotFather gives you something like 123456789:AA… — paste the whole line.');
    }
    // a new token starts unpaired on purpose: the chat is re-confirmed against the bot that will serve it
    await writeTelegramConfig(this.userDataDir, { token: trimmed, chatId: null, chatName: null }, this.safeStorage);
    this.start(trimmed, null);
    return this.status();
  }

  /** Binds to a chat that has actually messaged the bot; any other id is refused. */
  async pair(chatId: number): Promise<TelegramStatus> {
    const config = await readTelegramConfig(this.userDataDir, this.safeStorage);
    if (!config) throw new Error('Save a bot token first.');
    const candidate = this.engine.telegramStatus().candidate;
    if (!candidate || candidate.chatId !== chatId) {
      throw new Error('That chat has not messaged the bot. Send the bot a message from the phone you want to pair, then try again.');
    }
    await writeTelegramConfig(this.userDataDir, { token: config.token, chatId, chatName: candidate.name }, this.safeStorage);
    this.start(config.token, chatId);
    return this.status();
  }

  async unpair(): Promise<TelegramStatus> {
    const config = await readTelegramConfig(this.userDataDir, this.safeStorage);
    if (!config) return { ...NO_TELEGRAM };
    await writeTelegramConfig(this.userDataDir, { token: config.token, chatId: null, chatName: null }, this.safeStorage);
    this.start(config.token, null);
    return this.status();
  }

  test(): Promise<void> {
    return this.engine.telegramTest();
  }

  /** A bridge that will not start is a Settings problem, never a reason to fail the call. */
  private start(token: string, chatId: number | null): void {
    try {
      this.engine.startTelegram({ token, chatId });
      this.startError = null;
    } catch (err) {
      this.startError = err instanceof Error ? err.message : String(err);
      console.error('[relay] the Telegram bridge could not start:', err);
    }
  }
}
