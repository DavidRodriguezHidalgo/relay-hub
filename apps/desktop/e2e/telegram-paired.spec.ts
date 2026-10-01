import { _electron as electron, expect, test } from '@playwright/test';
import { copyFile, mkdir, mkdtemp } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const fixtures = resolve(__dirname, '../../../packages/engine/test/fixtures');
const CHAT = 4242;

/**
 * Telegram's Bot API, stood in for on localhost, so the whole app can be driven exactly as a
 * phone drives it: pairing in Settings, a message arriving, an answer going back.
 */
class StandInTelegram {
  readonly sent: { chat_id: number; text: string }[] = [];
  private pending: unknown[] = [];
  private id = 1;
  private server: Server | null = null;
  port = 0;

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      const method = req.url?.split('/').pop() ?? '';
      let body = '';
      req.on('data', (c) => (body += String(c)));
      req.on('end', () => {
        const input = body ? (JSON.parse(body) as Record<string, unknown>) : {};
        const reply = (result: unknown) => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true, result }));
        };
        if (method === 'getMe') return reply({ id: 1, username: 'relay_stand_in_bot', is_bot: true });
        if (method === 'getUpdates') {
          // A poll whose client has gone (the bridge was restarted to pair) must not swallow an
          // update: real Telegram would redeliver it, since we only confirm what we have handled.
          // `res` closing before we have written is the client going away; `req` closes as soon
          // as its body has been read, which is not the same thing at all
          let gone = false;
          res.on('close', () => (gone = true));
          const answer = () => {
            if (gone) return;
            if (this.pending.length > 0) return reply(this.pending.splice(0));
            setTimeout(answer, 50);
          };
          return answer();
        }
        if (method === 'sendMessage') {
          this.sent.push(input as never);
          return reply({ message_id: this.id++ });
        }
        return reply(true);
      });
    });
    await new Promise<void>((r) => this.server!.listen(0, '127.0.0.1', r));
    this.port = (this.server!.address() as AddressInfo).port;
  }

  deliver(chatId: number, text: string): void {
    this.pending.push({
      update_id: this.id++,
      message: { message_id: this.id++, chat: { id: chatId, type: 'private', first_name: 'David' }, from: { id: chatId, first_name: 'David', last_name: 'R' }, date: 0, text },
    });
  }

  stop(): Promise<void> {
    return new Promise((r) => this.server?.close(() => r()));
  }
}

test('binds itself to the first chat that writes, answers it, and refuses every other chat', async () => {
  const telegram = new StandInTelegram();
  await telegram.start();
  const root = await mkdtemp(join(tmpdir(), 'relay-e2e-paired-'));
  await mkdir(join(root, 'projects', 'p'), { recursive: true });
  await copyFile(join(fixtures, 'basic.jsonl'), join(root, 'projects', 'p', 'basic.jsonl'));
  const app = await electron.launch({
    args: [resolve(__dirname, '../.vite/build/main.js'), `--user-data-dir=${join(root, 'userData')}`],
    env: { ...process.env, RELAY_PROJECTS_DIR: join(root, 'projects'), RELAY_TELEGRAM_API: `http://127.0.0.1:${telegram.port}` },
  });
  const page = await app.firstWindow();
  const dialog = page.getByRole('region', { name: 'Telegram' });
  const openSettings = async () => {
    await page.getByRole('button', { name: 'Settings' }).click();
    await expect(dialog).toBeVisible();
  };

  await openSettings();
  await dialog.getByLabel('Bot token').fill('123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw');
  await dialog.getByRole('button', { name: 'Save token' }).click();
  await expect(dialog.getByText('@relay_stand_in_bot', { exact: true })).toBeVisible();

  // the first chat to write becomes the owner's, with no second step in Settings.
  // It writes /status rather than prose on purpose: a command is answered by the bridge itself,
  // so this test never calls the model and stays fast and deterministic in CI.
  await expect(dialog).toContainText('Now message');
  telegram.deliver(CHAT, '/status');
  await expect(dialog).toContainText(`Paired with David R (chat ${CHAT})`, { timeout: 20_000 });
  await expect.poll(() => telegram.sent.map((s) => s.text).join('\n'), { timeout: 10_000 }).toMatch(/Paired with this chat/);

  // a message from the paired chat is answered, without the AI for /status
  const before = telegram.sent.length;
  telegram.deliver(CHAT, '/status');
  await expect.poll(() => telegram.sent.length, { timeout: 20_000 }).toBeGreaterThan(before);
  const status = telegram.sent[telegram.sent.length - 1]!;
  expect(status.chat_id).toBe(CHAT);
  // the message that bound the chat is also an instruction, so Relay may well be busy with it
  expect(status.text).toMatch(/Nothing is running|Running:|Relay chat is working/);

  // a message from anyone else is dropped without a reply. Counting messages would be flaky —
  // a reply to the owner can still be on its way — so the property checked is the real one:
  // nothing Relay ever sends goes anywhere but the bound chat.
  telegram.deliver(9999, '/status');
  await page.waitForTimeout(3_000);
  expect(telegram.sent.map((s) => s.chat_id)).toEqual(telegram.sent.map(() => CHAT));

  // the test button reaches the phone
  await dialog.getByRole('button', { name: 'Send test message' }).click();
  await expect(dialog.getByText('Sent — check your phone.')).toBeVisible();
  expect(telegram.sent[telegram.sent.length - 1]!.text).toMatch(/can reach this phone/);

  await app.close();
  await telegram.stop();
});
