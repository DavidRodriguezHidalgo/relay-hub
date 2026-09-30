import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { copyFile, mkdir, mkdtemp, readdir, rm, utimes } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { RelayEngine } from '../../src/relay-engine';
import { HttpTelegramApi, type TelegramUpdate } from '../../src/telegram/telegram-api';

/**
 * The whole path, for real: a message arrives as Telegram would deliver it, the orchestrator
 * finds a real Claude session, drives it, and the reply comes back as a sent message.
 *
 * Only Telegram's own servers are stood in for — everything else is the real engine and a real
 * `claude`. Opt in with `RELAY_LIVE=<project dir under ~/.claude/projects>`; it spends tokens.
 */
const LIVE = process.env.RELAY_LIVE;

/** Telegram's Bot API, as much of it as the bridge calls, over HTTP on localhost. */
class FakeTelegramServer {
  readonly sent: { chat_id: number; text: string; reply_markup?: unknown }[] = [];
  readonly edits: { message_id: number; text: string }[] = [];
  private pending: TelegramUpdate[] = [];
  private nextId = 1;
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
        switch (method) {
          case 'getMe':
            return reply({ id: 1, username: 'relay_test_bot', is_bot: true });
          case 'getUpdates': {
            // long poll: answer as soon as there is something, else after a moment with nothing
            const answer = () => {
              if (this.pending.length > 0) return reply(this.pending.splice(0));
              setTimeout(answer, 50);
            };
            return answer();
          }
          case 'sendMessage':
            this.sent.push(input as never);
            return reply({ message_id: this.nextId++ });
          case 'editMessageText':
            this.edits.push(input as never);
            return reply(true);
          default:
            return reply(true);
        }
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    this.port = (this.server!.address() as AddressInfo).port;
  }

  /** A message from the paired chat, exactly as Telegram would deliver it. */
  deliver(chatId: number, text: string): void {
    this.pending.push({
      update_id: this.nextId++,
      message: { message_id: this.nextId++, chat: { id: chatId, type: 'private', first_name: 'David' }, from: { id: chatId, first_name: 'David' }, date: Math.floor(Date.now() / 1000), text },
    });
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }
}

const CHAT = 4242;

describe.skipIf(!LIVE)('the Telegram bridge against a real session', () => {
  let root: string;
  let engine: RelayEngine;
  let telegram: FakeTelegramServer;

  const waitFor = async (what: string, pred: () => boolean, ms = 240_000) => {
    const started = Date.now();
    while (!pred()) {
      if (Date.now() - started > ms) throw new Error(`timed out waiting for ${what}; sent so far: ${JSON.stringify(telegram.sent)}`);
      await new Promise((r) => setTimeout(r, 200));
    }
  };
  const said = (pattern: RegExp) => telegram.sent.some((m) => pattern.test(m.text));

  beforeAll(async () => {
    const source = join(homedir(), '.claude', 'projects', LIVE!);
    const files = (await readdir(source)).filter((f) => f.endsWith('.jsonl'));
    expect(files.length).toBeGreaterThan(0);
    root = await mkdtemp(join(tmpdir(), 'relay-telegram-live-'));
    await mkdir(join(root, 'projects', LIVE!), { recursive: true });
    const copy = join(root, 'projects', LIVE!, files[0]!);
    await copyFile(join(source, files[0]!), copy);
    const old = new Date(Date.now() - 60_000);
    await utimes(copy, old, old);

    telegram = new FakeTelegramServer();
    await telegram.start();
    engine = await RelayEngine.start({
      projectsDir: join(root, 'projects'),
      dbPath: join(root, 'relay.db'),
      orchestratorDir: join(root, 'orch'),
    });
    engine.startTelegram({
      token: '123456789:fake-token-for-the-stand-in-server',
      chatId: CHAT,
      api: new HttpTelegramApi('123456789:fake-token-for-the-stand-in-server', { baseUrl: `http://127.0.0.1:${telegram.port}` }),
    });
  }, 120_000);

  afterAll(async () => {
    await engine?.close();
    await telegram?.stop();
    await rm(root, { recursive: true, force: true });
  });

  it('answers /status from the phone without spending a token', async () => {
    telegram.deliver(CHAT, '/status');
    await waitFor('a status answer', () => telegram.sent.length > 0, 30_000);
    expect(telegram.sent[0]!.chat_id).toBe(CHAT);
    expect(telegram.sent[0]!.text).toMatch(/Nothing is running|Running:/);
  }, 60_000);

  it('ignores a message from any other chat', async () => {
    const before = telegram.sent.length;
    telegram.deliver(9999, '/status');
    await new Promise((r) => setTimeout(r, 3_000));
    expect(telegram.sent).toHaveLength(before);
  }, 30_000);

  it('carries an instruction from the phone to a real session and brings the reply back', async () => {
    telegram.sent.length = 0;
    telegram.deliver(CHAT, 'Tell the session in repo relay-scratch to reply with exactly the word: pong. Do not ask me to confirm.');
    // the orchestrator answers the phone once it has sent
    await waitFor('the orchestrator to answer the phone', () => telegram.sent.length > 0);
    // and the session's own turn end is reported afterwards, carrying its reply
    await waitFor('the session turn to be reported', () => said(/^✔/m));
    console.log('phone received:\n' + telegram.sent.map((m, i) => `  [${i}] ${m.text.replace(/\n/g, '\n      ')}`).join('\n'));
    expect(said(/✔.*\n\n.*pong/is)).toBe(true);
  }, 600_000);
});
