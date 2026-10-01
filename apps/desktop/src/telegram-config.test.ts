// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readTelegramConfig, validTokenShape, writeTelegramConfig } from './telegram-config';

/** Electron's safeStorage, as far as this module uses it. */
const working = {
  isEncryptionAvailable: () => true,
  encryptString: (s: string) => Buffer.from(`enc:${s}`),
  decryptString: (b: Buffer) => Buffer.from(b).toString('utf8').replace(/^enc:/, ''),
};
const unavailable = { ...working, isEncryptionAvailable: () => false };

const withDir = async (fn: (dir: string) => Promise<void>) => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-telegram-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

describe('telegram config', () => {
  it('is absent, and silent, until something is written', async () => {
    await withDir(async (dir) => {
      expect(await readTelegramConfig(dir, working)).toBeNull();
    });
  });

  it('round-trips a token and chat through the keychain', async () => {
    await withDir(async (dir) => {
      await writeTelegramConfig(dir, { token: '123:secret', chatId: 42, chatName: 'David' }, working);
      expect(await readTelegramConfig(dir, working)).toEqual({ token: '123:secret', chatId: 42, chatName: 'David', storage: 'encrypted' });
    });
  });

  it('never leaves the token in the file as plain text when encryption works', async () => {
    await withDir(async (dir) => {
      await writeTelegramConfig(dir, { token: '123:secret', chatId: null, chatName: null }, working);
      const raw = await readFile(join(dir, 'telegram.json'), 'utf8');
      expect(raw).not.toContain('123:secret');
      expect(JSON.parse(raw)).toMatchObject({ storage: 'encrypted' });
    });
  });

  it('falls back to plain storage where the OS offers no keychain, and says which it used', async () => {
    await withDir(async (dir) => {
      await writeTelegramConfig(dir, { token: '123:secret', chatId: null, chatName: null }, unavailable);
      expect(await readTelegramConfig(dir, unavailable)).toEqual({ token: '123:secret', chatId: null, chatName: null, storage: 'plain' });
      expect(await readFile(join(dir, 'telegram.json'), 'utf8')).toContain('123:secret');
    });
  });

  it('treats a file it cannot decrypt as no configuration rather than crashing the app', async () => {
    await withDir(async (dir) => {
      await writeTelegramConfig(dir, { token: '123:secret', chatId: 7, chatName: null }, working);
      const broken = { ...working, decryptString: () => { throw new Error('keychain says no'); } };
      expect(await readTelegramConfig(dir, broken)).toBeNull();
    });
  });

  it('treats a corrupt file as no configuration', async () => {
    await withDir(async (dir) => {
      await writeFile(join(dir, 'telegram.json'), '{ not json');
      expect(await readTelegramConfig(dir, working)).toBeNull();
    });
  });

  it('removes the file when the token is cleared', async () => {
    await withDir(async (dir) => {
      await writeTelegramConfig(dir, { token: '123:secret', chatId: 1, chatName: null }, working);
      await writeTelegramConfig(dir, null, working);
      expect(await readTelegramConfig(dir, working)).toBeNull();
    });
  });

  it('knows what a bot token looks like, so a pasted mistake is caught before Telegram is called', () => {
    expect(validTokenShape('123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw')).toBe(true);
    expect(validTokenShape('  123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw  ')).toBe(true);
    expect(validTokenShape('not-a-token')).toBe(false);
    expect(validTokenShape('123456789')).toBe(false);
    expect(validTokenShape('')).toBe(false);
    expect(validTokenShape('abc:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw')).toBe(false);
  });
});
