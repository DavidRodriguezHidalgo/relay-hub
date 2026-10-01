import { describe, expect, it } from 'vitest';
import { HttpTelegramApi, TelegramApiError } from '../../src/telegram/telegram-api';

type Call = { url: string; body: unknown; signal: AbortSignal | null | undefined };

/** A fetch that records calls and answers from a script of responses. */
function fakeFetch(answers: Array<{ status?: number; json?: unknown; throws?: Error }>) {
  const calls: Call[] = [];
  const fetch = async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null, signal: init?.signal });
    const next = answers.shift() ?? { status: 200, json: { ok: true, result: null } };
    if (next.throws) throw next.throws;
    return new Response(JSON.stringify(next.json ?? { ok: true, result: null }), { status: next.status ?? 200, headers: { 'content-type': 'application/json' } });
  };
  return { calls, fetch: fetch as unknown as typeof globalThis.fetch };
}

const TOKEN = '123456:ABC-secret';

describe('HttpTelegramApi', () => {
  it('posts JSON to the bot method URL and unwraps the result', async () => {
    const f = fakeFetch([{ json: { ok: true, result: { id: 7, username: 'relay_bot', is_bot: true } } }]);
    const api = new HttpTelegramApi(TOKEN, { fetch: f.fetch, baseUrl: 'https://t.example' });
    expect(await api.getMe()).toEqual({ id: 7, username: 'relay_bot' });
    expect(f.calls[0]!.url).toBe('https://t.example/bot123456:ABC-secret/getMe');
  });

  it('asks for updates from the offset with a long-poll timeout, only messages and button presses', async () => {
    const f = fakeFetch([{ json: { ok: true, result: [{ update_id: 5, message: { message_id: 1, chat: { id: 9, type: 'private' }, date: 0, text: 'hi' } }] } }]);
    const api = new HttpTelegramApi(TOKEN, { fetch: f.fetch });
    const updates = await api.getUpdates(5, 30);
    expect(updates).toHaveLength(1);
    expect(f.calls[0]!.body).toEqual({ offset: 5, timeout: 30, allowed_updates: ['message', 'callback_query'] });
    expect(f.calls[0]!.signal).toBeDefined();
  });

  it('omits the offset on the very first poll', async () => {
    const f = fakeFetch([{ json: { ok: true, result: [] } }]);
    await new HttpTelegramApi(TOKEN, { fetch: f.fetch }).getUpdates(null, 1);
    expect(f.calls[0]!.body).toEqual({ timeout: 1, allowed_updates: ['message', 'callback_query'] });
  });

  it('sends plain text, with a keyboard when given, and returns the message id', async () => {
    const f = fakeFetch([{ json: { ok: true, result: { message_id: 42 } } }]);
    const api = new HttpTelegramApi(TOKEN, { fetch: f.fetch });
    const keyboard = { inline_keyboard: [[{ text: 'Deny', callback_data: 'a:1:deny' }]] };
    expect(await api.sendMessage(9, 'hello_world *raw*', keyboard)).toEqual({ messageId: 42 });
    expect(f.calls[0]!.body).toEqual({ chat_id: 9, text: 'hello_world *raw*', reply_markup: keyboard });
    expect(f.calls[0]!.body).not.toHaveProperty('parse_mode');
  });

  it('edits, answers a button press, and shows typing', async () => {
    const f = fakeFetch([{}, {}, {}]);
    const api = new HttpTelegramApi(TOKEN, { fetch: f.fetch });
    await api.editMessageText(9, 42, 'done');
    await api.answerCallbackQuery('cb1', 'Denied');
    await api.sendChatAction(9, 'typing');
    expect(f.calls.map((c) => c.url.split('/').at(-1))).toEqual(['editMessageText', 'answerCallbackQuery', 'sendChatAction']);
    expect(f.calls[0]!.body).toEqual({ chat_id: 9, message_id: 42, text: 'done' });
    expect(f.calls[1]!.body).toEqual({ callback_query_id: 'cb1', text: 'Denied' });
  });

  it("turns Telegram's error answers into a typed error with the status", async () => {
    const f = fakeFetch([{ status: 401, json: { ok: false, error_code: 401, description: 'Unauthorized' } }]);
    const api = new HttpTelegramApi(TOKEN, { fetch: f.fetch });
    const err = await api.getMe().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TelegramApiError);
    expect((err as TelegramApiError).status).toBe(401);
    expect((err as TelegramApiError).message).toBe('Telegram answered 401: Unauthorized');
  });

  it('never lets the token into an error message', async () => {
    const f = fakeFetch([{ throws: new Error(`connect ECONNREFUSED https://api.telegram.org/bot${TOKEN}/getMe`) }]);
    const api = new HttpTelegramApi(TOKEN, { fetch: f.fetch });
    const err = (await api.getMe().catch((e: unknown) => e)) as Error;
    expect(err.message).not.toContain('ABC-secret');
    expect(err.message).toContain('ECONNREFUSED');
  });

  it('reports a non-JSON answer as unreachable rather than crashing on the parse', async () => {
    const fetch = (async () => new Response('<html>502</html>', { status: 502 })) as unknown as typeof globalThis.fetch;
    const api = new HttpTelegramApi(TOKEN, { fetch });
    const err = await api.getMe().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TelegramApiError);
    expect((err as TelegramApiError).status).toBe(502);
  });
});
