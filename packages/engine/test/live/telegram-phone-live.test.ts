import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { copyFile, mkdir, mkdtemp, readdir, rm, utimes } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RunnerEvent } from '@relay/shared';
import { RelayEngine } from '../../src/relay-engine';

/**
 * The whole path with nothing stood in for: a real bot, a real chat, a real Claude session.
 *
 * Needs a person to send the message, so it is never part of a suite run:
 *   RELAY_LIVE=<project dir> RELAY_LIVE_TELEGRAM='<token>:<chatId>' vitest run test/live/telegram-phone-live
 */
const LIVE = process.env.RELAY_LIVE;
const TG = process.env.RELAY_LIVE_TELEGRAM;
const split = (value: string) => {
  const at = value.lastIndexOf(':');
  return { token: value.slice(0, at), chatId: Number(value.slice(at + 1)) };
};

describe.skipIf(!LIVE || !TG)('Relay driven from a real phone', () => {
  let root: string;
  let engine: RelayEngine;
  const events: RunnerEvent[] = [];

  beforeAll(async () => {
    const source = join(homedir(), '.claude', 'projects', LIVE!);
    const files = (await readdir(source)).filter((f) => f.endsWith('.jsonl'));
    root = await mkdtemp(join(tmpdir(), 'relay-phone-'));
    await mkdir(join(root, 'projects', LIVE!), { recursive: true });
    const copy = join(root, 'projects', LIVE!, files[0]!);
    await copyFile(join(source, files[0]!), copy);
    const old = new Date(Date.now() - 60_000);
    await utimes(copy, old, old);
    engine = await RelayEngine.start({
      projectsDir: join(root, 'projects'),
      dbPath: join(root, 'relay.db'),
      orchestratorDir: join(root, 'orch'),
    });
    engine.onEvent((e) => events.push(e));
    const { token, chatId } = split(TG!);
    engine.startTelegram({ token, chatId });
  }, 120_000);

  afterAll(async () => {
    await engine?.close();
    await rm(root, { recursive: true, force: true });
  });

  it('takes an instruction sent from Telegram and drives a real session with it', async () => {
    const sessions = engine.listSessions();
    console.log(`\n  Relay is listening on your chat. Sessions it can reach: ${sessions.map((s) => `"${s.title}"`).join(', ')}`);
    console.log('  Send this to the bot now:\n');
    console.log('    tell the session in relay-scratch to reply with exactly the word: pong\n');

    const sawPong = () =>
      events.some(
        (e) =>
          e.type === 'entry' &&
          e.entry.role === 'assistant' &&
          e.entry.blocks.some((b) => b.kind === 'text' && /pong/i.test(b.text)),
      );
    const started = Date.now();
    while (!sawPong()) {
      if (Date.now() - started > 420_000) throw new Error('no instruction arrived from Telegram in time');
      await new Promise((r) => setTimeout(r, 500));
    }
    // the session answered; its turn-end is what carries the ✔ back to the phone
    const ends = events.filter((e) => e.type === 'turn-end');
    console.log(`\n  A session replied with "pong". Turn ends seen: ${ends.length}. Check your phone for the ✔ message.\n`);
    expect(sawPong()).toBe(true);
  }, 600_000);
});
