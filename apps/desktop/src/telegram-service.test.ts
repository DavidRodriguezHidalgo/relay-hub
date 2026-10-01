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
  botUsername: 'relay_bot', chatId: null, chatName: null, connection: 'ok', lastError: null, lastPolledAt: null, ignored: 0, ...over,
});

function fakeEngine() {
  const engine = {
    started: [] as { token: string; chatId: number | null; chatName?: string | null }[],
    stops: 0,
    tests: 0,
    status: running(),
    /** Stands in for the bridge binding itself to the first chat that writes. */
    pairNow: null as null | ((paired: { chatId: number; name: string }) => void),
    startTelegram(opts: { token: string; chatId: number | null; chatName?: string | null; onPaired?: (p: { chatId: number; name: string }) => void }) {
      engine.started.push({ token: opts.token, chatId: opts.chatId, chatName: opts.chatName ?? null });
      engine.status = running({ chatId: opts.chatId, chatName: opts.chatName ?? null });
      engine.pairNow = (paired) => {
        engine.status = running({ chatId: paired.chatId, chatName: paired.name });
        opts.onPaired?.(paired);
      };
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
      expect(engine.started).toEqual([{ token: '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw', chatId: null, chatName: null }]);
      expect(status).toMatchObject({ configured: true, storage: 'encrypted', chatId: null });
    });
  });

  it('refuses something that is not a bot token, without calling Telegram', async () => {
    await withService(async (service, engine) => {
      await expect(service.setToken('hello')).rejects.toThrow(/does not look like a bot token/);
      expect(engine.started).toEqual([]);
    });
  });

  it('remembers the chat the bridge bound itself to, without a restart, and across one', async () => {
    await withService(async (service, engine, dir) => {
      await service.setToken('123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw');
      expect(engine.started).toHaveLength(1); // starts unbound and waits to be written to
      engine.pairNow!({ chatId: 42, name: 'David' });
      // the bridge keeps running: binding does not restart it and cannot lose the message that bound it
      expect(engine.started).toHaveLength(1);
      await new Promise((r) => setTimeout(r, 10)); // the write is fire-and-forget
      expect(await service.status()).toMatchObject({ configured: true, chatId: 42, chatName: 'David' });

      const second = new TelegramService(fakeEngine(), dir, safeStorage);
      await second.startIfConfigured();
      expect(await second.status()).toMatchObject({ configured: true, chatId: 42, chatName: 'David' });
    });
  });

  it('tells the app when a chat binds itself, so it can be seen where the user is looking', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'relay-telegram-svc-'));
    const engine = fakeEngine();
    const seen: { chatId: number; name: string }[] = [];
    const service = new TelegramService(engine, dir, safeStorage, (p) => seen.push(p));
    await service.setToken('123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw');
    engine.pairNow!({ chatId: 42, name: 'David' });
    expect(seen).toEqual([{ chatId: 42, name: 'David' }]);
    await rm(dir, { recursive: true, force: true });
  });

  it('a restart binds to the remembered chat rather than waiting to be written to again', async () => {
    await withService(async (service, engine, dir) => {
      await service.setToken('123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw');
      engine.pairNow!({ chatId: 42, name: 'David' });
      await new Promise((r) => setTimeout(r, 10));
      const next = fakeEngine();
      await new TelegramService(next, dir, safeStorage).startIfConfigured();
      expect(next.started.at(-1)).toMatchObject({ chatId: 42, chatName: 'David' });
    });
  });

  it('unpairs back to an unbound bridge, keeping the token, so the next chat to write takes over', async () => {
    await withService(async (service, engine) => {
      await service.setToken('123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw');
      engine.pairNow!({ chatId: 42, name: 'David' });
      await new Promise((r) => setTimeout(r, 10));
      const status = await service.unpair();
      expect(engine.started.at(-1)).toMatchObject({ chatId: null, chatName: null });
      expect(status).toMatchObject({ configured: true, chatId: null, chatName: null });
    });
  });

  it('removing the token stops the bridge and leaves nothing configured', async () => {
    await withService(async (service, engine, dir) => {
      await service.setToken('123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw');
      const status = await service.setToken(null);
      expect(engine.stops).toBe(1);
      expect(status).toEqual({ botUsername: null, chatId: null, chatName: null, connection: 'stopped', lastError: null, lastPolledAt: null, ignored: 0, configured: false, storage: null });
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
