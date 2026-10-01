import { NO_TELEGRAM, type TelegramBridgeStatus, type TelegramStatus } from '@relay/shared';
import { readTelegramConfig, validTokenShape, writeTelegramConfig, type SafeStorage } from './telegram-config';

/** The part of the engine this service drives; narrow so a test needs no engine. */
export interface TelegramCapableEngine {
  startTelegram(opts: {
    token: string;
    chatId: number | null;
    chatName?: string | null;
    onPaired?: (paired: { chatId: number; name: string }) => void;
  }): TelegramBridgeStatus;
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
    /** Told when a chat binds itself, so the app can say so where the user is looking. */
    private readonly onPaired?: (paired: { chatId: number; name: string }) => void,
  ) {}

  /** Called at startup: starts the bridge if a token was saved, and does nothing at all if not. */
  async startIfConfigured(): Promise<void> {
    const config = await readTelegramConfig(this.userDataDir, this.safeStorage);
    if (!config) return;
    this.start(config.token, config.chatId, config.chatName);
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
    // a new token starts unpaired on purpose: the chat is bound again against the bot that will serve it
    await writeTelegramConfig(this.userDataDir, { token: trimmed, chatId: null, chatName: null }, this.safeStorage);
    this.start(trimmed, null, null);
    return this.status();
  }

  /** Forgets the bound chat, so the next one to write takes its place. */
  async unpair(): Promise<TelegramStatus> {
    const config = await readTelegramConfig(this.userDataDir, this.safeStorage);
    if (!config) return { ...NO_TELEGRAM };
    await writeTelegramConfig(this.userDataDir, { token: config.token, chatId: null, chatName: null }, this.safeStorage);
    this.start(config.token, null, null);
    return this.status();
  }

  test(): Promise<void> {
    return this.engine.telegramTest();
  }

  /** A bridge that will not start is a Settings problem, never a reason to fail the call. */
  private start(token: string, chatId: number | null, chatName: string | null): void {
    try {
      this.engine.startTelegram({
        token,
        chatId,
        chatName,
        // the bridge binds itself to the first chat that writes; this is what makes it stick
        onPaired: ({ chatId: id, name }) => {
          void writeTelegramConfig(this.userDataDir, { token, chatId: id, chatName: name }, this.safeStorage).catch(
            (err: unknown) => console.error('[relay] could not remember the paired Telegram chat:', err),
          );
          this.onPaired?.({ chatId: id, name });
        },
      });
      this.startError = null;
    } catch (err) {
      this.startError = err instanceof Error ? err.message : String(err);
      console.error('[relay] the Telegram bridge could not start:', err);
    }
  }
}
