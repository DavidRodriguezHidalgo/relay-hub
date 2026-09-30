// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TelegramBridgeStatus } from '@relay/shared';
import { TelegramService } from './telegram-service';

const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (s: string) => Buffer.from(`enc:${s}`),
  decryptString: (b: Buffer) => Buffer.from(b).toString('utf8').replace(/^enc:/, ''),
};

const running = (over: Partial<TelegramBridgeStatus> = {}): TelegramBridgeStatus => ({
  botUsername: 'relay_bot', chatId: null, candidate: null, connection: 'ok', lastError: null, lastPolledAt: null, ignored: 0, ...over,
});

function fakeEngine() {
  const engine = {
    started: [] as { token: string; chatId: number | null }[],
    stops: 0,
    tests: 0,
    status: running(),
    startTelegram(opts: { token: string; chatId: number | null }) {
      engine.started.push(opts);
      engine.status = running({ chatId: opts.chatId });
      return engine.status;
    },
    stopTelegram() {
      engine.stops += 1;
      engine.status = running({ connection: 'stopped' });
    },
    telegramStatus: () => engine.status,
    telegramTest: async () => {
      engine.tests += 1;
    },
  };
  return engine;
}

const withService = async (fn: (s: TelegramService, e: ReturnType<typeof fakeEngine>, dir: string) => Promise<void>) => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-telegram-svc-'));
  const engine = fakeEngine();
  try {
    await fn(new TelegramService(engine, dir, safeStorage), engine, dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

describe('TelegramService', () => {
  it('starts nothing, and reports nothing, when no token was ever saved', async () => {
    await withService(async (service, engine) => {
      await service.startIfConfigured();
      expect(engine.started).toEqual([]);
      expect(await service.status()).toMatchObject({ configured: false, connection: 'stopped', storage: null });
    });
  });

  it('saves a token, starts the bridge unpaired, and says how the token is stored', async () => {
    await withService(async (service, engine) => {
      const status = await service.setToken('123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw');
      expect(engine.started).toEqual([{ token: '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw', chatId: null }]);
      expect(status).toMatchObject({ configured: true, storage: 'encrypted', chatId: null });
    });
  });

  it('refuses something that is not a bot token, without calling Telegram', async () => {
    await withService(async (service, engine) => {
      await expect(service.setToken('hello')).rejects.toThrow(/does not look like a bot token/);
      expect(engine.started).toEqual([]);
    });
  });

  it('restarts the bridge bound to the chat that was paired, and remembers it across a restart', async () => {
    await withService(async (service, engine, dir) => {
      await service.setToken('123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw');
      engine.status = running({ candidate: { chatId: 42, name: 'David', at: 't' } });
      const paired = await service.pair(42);
      expect(engine.started.at(-1)).toEqual({ token: '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw', chatId: 42 });
      expect(paired).toMatchObject({ chatId: 42, chatName: 'David' });

      const second = new TelegramService(fakeEngine(), dir, safeStorage);
      await second.startIfConfigured();
      expect(await second.status()).toMatchObject({ configured: true, chatId: 42, chatName: 'David' });
    });
  });

  it('refuses to pair a chat that never wrote, so a typed id cannot bind the bot to a stranger', async () => {
    await withService(async (service, engine) => {
      await service.setToken('123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw');
      engine.status = running({ candidate: { chatId: 42, name: 'David', at: 't' } });
      await expect(service.pair(99)).rejects.toThrow(/has not messaged/);
      expect(engine.started).toHaveLength(1);
    });
  });

  it('unpairs back to an unbound bridge, keeping the token', async () => {
    await withService(async (service, engine) => {
      await service.setToken('123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw');
      engine.status = running({ candidate: { chatId: 42, name: 'David', at: 't' } });
      await service.pair(42);
      const status = await service.unpair();
      expect(engine.started.at(-1)).toEqual({ token: '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw', chatId: null });
      expect(status).toMatchObject({ configured: true, chatId: null, chatName: null });
    });
  });

  it('removing the token stops the bridge and leaves nothing configured', async () => {
    await withService(async (service, engine, dir) => {
      await service.setToken('123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw');
      const status = await service.setToken(null);
      expect(engine.stops).toBe(1);
      expect(status).toEqual({ botUsername: null, chatId: null, candidate: null, connection: 'stopped', lastError: null, lastPolledAt: null, ignored: 0, configured: false, storage: null, chatName: null });
      const second = new TelegramService(fakeEngine(), dir, safeStorage);
      expect(await second.status()).toMatchObject({ configured: false });
    });
  });

  it('passes a test message through to the bridge', async () => {
    await withService(async (service, engine) => {
      await service.setToken('123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw');
      await service.test();
      expect(engine.tests).toBe(1);
    });
  });

  it('a start that throws is reported in the status, not thrown at the app', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'relay-telegram-svc-'));
    const engine = fakeEngine();
    engine.startTelegram = () => {
      throw new Error('no network stack');
    };
    const service = new TelegramService(engine, dir, safeStorage);
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(service.setToken('123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw')).resolves.toMatchObject({
      configured: true,
      connection: 'stopped',
      lastError: 'no network stack',
    });
    spy.mockRestore();
    await rm(dir, { recursive: true, force: true });
  });
});
