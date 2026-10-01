import { describe, expect, it } from 'vitest';
import { HttpTelegramApi, TelegramApiError } from '../../src/telegram/telegram-api';

/**
 * Against Telegram itself, with no bot: proves the real network path and that a bad token is
 * reported rather than thrown around. Opt in with `RELAY_LIVE_TELEGRAM_REJECT=1` (no secrets).
 */
describe.skipIf(!process.env.RELAY_LIVE_TELEGRAM_REJECT)('real Telegram', () => {
  it('rejects a token that is not a bot, cleanly and without repeating the token back', async () => {
    const token = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw';
    const err = await new HttpTelegramApi(token).getMe().catch((e: unknown) => e);
    console.log('real Telegram answered:', (err as Error).message);
    expect(err).toBeInstanceOf(TelegramApiError);
    expect((err as TelegramApiError).status).toBe(401);
    expect((err as Error).message).not.toContain(token);
  }, 30_000);
});

/**
 * The real bot, the real chat, the real servers — the one hop a stand-in cannot prove.
 *
 * Opt in with `RELAY_LIVE_TELEGRAM='<token>:<chatId>'`, e.g.
 *
 *   RELAY_LIVE_TELEGRAM='123456789:AA…:4242' pnpm --filter @relay/engine exec vitest run test/live/telegram-real-api
 *
 * Put it in the environment, never in a file: nothing here is written down, and the token is kept
 * out of every message this test prints.
 */
const LIVE = process.env.RELAY_LIVE_TELEGRAM;
/** The chat id is the last colon-separated field; the token itself contains one colon of its own. */
const split = (value: string) => {
  const at = value.lastIndexOf(':');
  return { token: value.slice(0, at), chatId: Number(value.slice(at + 1)) };
};

describe.skipIf(!LIVE)('a real bot and a real chat', () => {
  it('says which bot it is, delivers a message to the chat, and can edit it afterwards', async () => {
    const { token, chatId } = split(LIVE!);
    expect(Number.isFinite(chatId), 'RELAY_LIVE_TELEGRAM must end in :<chatId>').toBe(true);
    const api = new HttpTelegramApi(token);

    const me = await api.getMe();
    console.log(`bot: @${me.username ?? me.id}`);
    expect(me.id).toBeGreaterThan(0);

    const stamp = new Date().toISOString();
    const sent = await api.sendMessage(chatId, `Relay Hub live check ${stamp}`);
    expect(sent.messageId).toBeGreaterThan(0);
    console.log(`sent message ${sent.messageId} to chat ${chatId} — check the phone`);

    // the same call the bridge makes when an approval is decided elsewhere
    await api.editMessageText(chatId, sent.messageId, `Relay Hub live check ${stamp}\n\n→ edited, so approvals can be updated in place.`);

    // and the buttons an approval arrives with
    const withButtons = await api.sendMessage(chatId, 'Relay Hub live check: this is what an approval looks like.', {
      inline_keyboard: [[{ text: 'Deny', callback_data: 'a:live:deny' }, { text: 'Allow once', callback_data: 'a:live:allow' }]],
    });
    expect(withButtons.messageId).toBeGreaterThan(0);
  }, 60_000);

  it('refuses a chat that is not the paired one, which is what an intruder would hit', async () => {
    const { token } = split(LIVE!);
    // a chat this bot has never spoken to: Telegram itself refuses, before any of Relay's own checks
    const err = await new HttpTelegramApi(token).sendMessage(1, 'should never arrive').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TelegramApiError);
    expect((err as Error).message).not.toContain(token);
    console.log('telegram refused an unknown chat with:', (err as Error).message);
  }, 30_000);
});
