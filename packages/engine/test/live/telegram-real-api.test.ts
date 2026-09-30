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
