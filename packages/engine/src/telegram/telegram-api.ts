/**
 * The slice of Telegram's Bot API that Relay uses, over `fetch`.
 *
 * No library: five methods, plain JSON, and one place to make sure the token never leaks
 * into an error message (it is part of every URL).
 */

export interface TelegramUser {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
}

export interface TelegramChat {
  id: number;
  /** `private`, `group`, `supergroup` or `channel`; only `private` is ever honoured. */
  type: string;
  first_name?: string;
  last_name?: string;
  username?: string;
}

export interface TelegramMessage {
  message_id: number;
  chat: TelegramChat;
  from?: TelegramUser;
  date: number;
  text?: string;
}

export interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  message?: TelegramMessage;
  data?: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

export interface InlineKeyboard {
  inline_keyboard: { text: string; callback_data: string }[][];
}

export interface TelegramApi {
  getMe(): Promise<{ id: number; username: string | null }>;
  /** Long-polls for up to `timeoutSec`; `offset` null asks for whatever is pending. */
  getUpdates(offset: number | null, timeoutSec: number, signal?: AbortSignal): Promise<TelegramUpdate[]>;
  sendMessage(chatId: number, text: string, keyboard?: InlineKeyboard): Promise<{ messageId: number }>;
  editMessageText(chatId: number, messageId: number, text: string, keyboard?: InlineKeyboard): Promise<void>;
  answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void>;
  sendChatAction(chatId: number, action: 'typing'): Promise<void>;
}

/** Telegram answered, but with an error; `status` is its error code (401, 409, 429...). */
export class TelegramApiError extends Error {
  constructor(
    readonly status: number,
    readonly description: string,
  ) {
    super(`Telegram answered ${status}: ${description}`);
    this.name = 'TelegramApiError';
  }
}

export const TELEGRAM_API = 'https://api.telegram.org';
/** Slack over the long-poll timeout before the request itself is abandoned. */
const POLL_GRACE_MS = 10_000;
const REQUEST_TIMEOUT_MS = 30_000;

export interface HttpTelegramApiOptions {
  fetch?: typeof globalThis.fetch;
  baseUrl?: string;
}

export class HttpTelegramApi implements TelegramApi {
  private readonly fetch: typeof globalThis.fetch;
  private readonly base: string;

  constructor(
    private readonly token: string,
    opts: HttpTelegramApiOptions = {},
  ) {
    this.fetch = opts.fetch ?? globalThis.fetch;
    this.base = (opts.baseUrl ?? TELEGRAM_API).replace(/\/$/, '');
  }

  async getMe(): Promise<{ id: number; username: string | null }> {
    const me = await this.call<{ id: number; username?: string }>('getMe', {});
    return { id: me.id, username: me.username ?? null };
  }

  getUpdates(offset: number | null, timeoutSec: number, signal?: AbortSignal): Promise<TelegramUpdate[]> {
    const body = { ...(offset === null ? {} : { offset }), timeout: timeoutSec, allowed_updates: ['message', 'callback_query'] };
    return this.call<TelegramUpdate[]>('getUpdates', body, timeoutSec * 1000 + POLL_GRACE_MS, signal);
  }

  async sendMessage(chatId: number, text: string, keyboard?: InlineKeyboard): Promise<{ messageId: number }> {
    const sent = await this.call<{ message_id: number }>('sendMessage', {
      chat_id: chatId,
      text,
      ...(keyboard ? { reply_markup: keyboard } : {}),
    });
    return { messageId: sent.message_id };
  }

  async editMessageText(chatId: number, messageId: number, text: string, keyboard?: InlineKeyboard): Promise<void> {
    await this.call('editMessageText', { chat_id: chatId, message_id: messageId, text, ...(keyboard ? { reply_markup: keyboard } : {}) });
  }

  async answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void> {
    await this.call('answerCallbackQuery', { callback_query_id: callbackQueryId, ...(text ? { text } : {}) });
  }

  async sendChatAction(chatId: number, action: 'typing'): Promise<void> {
    await this.call('sendChatAction', { chat_id: chatId, action });
  }

  private async call<T>(method: string, body: Record<string, unknown>, timeoutMs = REQUEST_TIMEOUT_MS, signal?: AbortSignal): Promise<T> {
    const timeout = AbortSignal.timeout(timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let response: Response;
    try {
      response = await this.fetch(`${this.base}/bot${this.token}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: combined,
      });
    } catch (err) {
      throw new Error(this.redact(err instanceof Error ? (err.cause instanceof Error ? `${err.message}: ${err.cause.message}` : err.message) : String(err)));
    }
    type Envelope = { ok?: boolean; result?: T; description?: string; error_code?: number };
    let parsed: Envelope | null;
    try {
      parsed = (await response.json()) as Envelope;
    } catch {
      parsed = null;
    }
    if (!parsed || parsed.ok !== true) {
      throw new TelegramApiError(parsed?.error_code ?? response.status, this.redact(parsed?.description ?? `HTTP ${response.status}`));
    }
    return parsed.result as T;
  }

  private redact(text: string): string {
    return text.split(this.token).join('<token>');
  }
}
