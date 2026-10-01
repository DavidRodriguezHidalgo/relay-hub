import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Where the bot token lives.
 *
 * Its own file rather than the engine's database, because the engine is deliberately given no
 * way to keep a secret: it is handed a token to use, or it runs nothing about Telegram at all.
 * On macOS `safeStorage` puts the key in the Keychain, so the file on disk is useless on its own.
 */
const FILE = 'telegram.json';

/** The slice of Electron's `safeStorage` this module uses; injected so a test needs no Electron. */
export interface SafeStorage {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

export interface TelegramConfig {
  token: string;
  /** The paired chat, once the user has accepted one. */
  chatId: number | null;
  chatName: string | null;
}

export type StoredTelegramConfig = TelegramConfig & { storage: 'encrypted' | 'plain' };

type FileShape = {
  storage?: 'encrypted' | 'plain';
  token?: string;
  tokenEncrypted?: string;
  chatId?: number | null;
  chatName?: string | null;
};

/** BotFather issues `<digits>:<35 or so of base64-ish>`; catching a mistyped paste here saves a pointless call. */
export function validTokenShape(token: string): boolean {
  return /^\d{5,}:[A-Za-z0-9_-]{30,}$/.test(token.trim());
}

/** The stored configuration, or null when there is none, when it is corrupt, or when it cannot be decrypted. */
export async function readTelegramConfig(userDataDir: string, safeStorage: SafeStorage): Promise<StoredTelegramConfig | null> {
  let parsed: FileShape;
  try {
    parsed = JSON.parse(await readFile(join(userDataDir, FILE), 'utf8')) as FileShape;
  } catch {
    // never written, unreadable, or not JSON: all mean "no Telegram configured", and none is worth an error
    return null;
  }
  try {
    const chat = { chatId: parsed.chatId ?? null, chatName: parsed.chatName ?? null };
    if (parsed.storage === 'encrypted' && typeof parsed.tokenEncrypted === 'string') {
      const token = safeStorage.decryptString(Buffer.from(parsed.tokenEncrypted, 'base64'));
      return token ? { token, ...chat, storage: 'encrypted' } : null;
    }
    if (typeof parsed.token === 'string' && parsed.token) return { token: parsed.token, ...chat, storage: 'plain' };
    return null;
  } catch {
    // a keychain that will not give the key back: treat it as unconfigured so the app still starts
    return null;
  }
}

/** Writes the configuration, encrypted where the OS allows; `null` removes it. */
export async function writeTelegramConfig(userDataDir: string, config: TelegramConfig | null, safeStorage: SafeStorage): Promise<'encrypted' | 'plain' | null> {
  const path = join(userDataDir, FILE);
  if (!config) {
    await rm(path, { force: true });
    return null;
  }
  await mkdir(userDataDir, { recursive: true });
  const encrypt = safeStorage.isEncryptionAvailable();
  const body: FileShape = encrypt
    ? { storage: 'encrypted', tokenEncrypted: safeStorage.encryptString(config.token).toString('base64'), chatId: config.chatId, chatName: config.chatName }
    : { storage: 'plain', token: config.token, chatId: config.chatId, chatName: config.chatName };
  await writeFile(path, JSON.stringify(body, null, 2), { mode: 0o600 });
  return encrypt ? 'encrypted' : 'plain';
}
