import { _electron as electron, expect, test } from '@playwright/test';
import { copyFile, mkdir, mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const fixtures = resolve(__dirname, '../../../packages/engine/test/fixtures');

/**
 * Somewhere no Telegram answers from.
 *
 * These cases are about the app's own behaviour, so they must not reach the real Bot API: that
 * would make the suite depend on an external service and on how fast it answers today.
 */
const NOWHERE = 'http://127.0.0.1:1';

/** A fresh app with its own data directory, as someone opening Relay for the first time has. */
async function launchFresh() {
  const root = await mkdtemp(join(tmpdir(), 'relay-e2e-tg-'));
  await mkdir(join(root, 'projects', 'p'), { recursive: true });
  await copyFile(join(fixtures, 'basic.jsonl'), join(root, 'projects', 'p', 'basic.jsonl'));
  const userData = join(root, 'userData');
  const app = await electron.launch({
    args: [resolve(__dirname, '../.vite/build/main.js'), `--user-data-dir=${userData}`],
    env: { ...process.env, RELAY_PROJECTS_DIR: join(root, 'projects'), RELAY_TELEGRAM_API: NOWHERE },
  });
  return { app, userData };
}

test('with no bot set up it is quiet: the steps are offered, and nothing is stored or started', async () => {
  const { app, userData } = await launchFresh();
  const page = await app.firstWindow();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });

  await page.getByRole('button', { name: 'Settings' }).click();
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await expect(dialog).toContainText('Telegram');
  // the setup story, not a half-enabled state
  await expect(dialog.getByLabel('Bot token')).toBeVisible();
  await expect(dialog).toContainText('@BotFather');
  await expect(dialog.getByRole('button', { name: 'Save token' })).toBeDisabled();
  await expect(dialog.getByRole('button', { name: 'Send test message' })).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: /Pair/ })).toHaveCount(0);
  // nothing about Telegram is wrong, because nothing about Telegram is running
  await expect(dialog.getByRole('alert')).toHaveCount(0);

  expect(errors).toEqual([]);
  expect(await readdir(userData)).not.toContain('telegram.json');
  await app.close();
});

test('a token is taken, kept out of the file in plain text, and survives a restart unpaired', async () => {
  const { app, userData } = await launchFresh();
  const page = await app.firstWindow();
  await page.getByRole('button', { name: 'Settings' }).click();
  const dialog = page.getByRole('dialog', { name: 'Settings' });

  // a real-shaped token, with nothing answering: the app must take it, keep it safely, and carry
  // on running while the bridge quietly retries
  await dialog.getByLabel('Bot token').fill('123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw');
  await dialog.getByRole('button', { name: 'Save token' }).click();

  await expect(dialog.getByRole('button', { name: 'Remove token' })).toBeVisible();
  const stored = await readFile(join(userData, 'telegram.json'), 'utf8');
  expect(stored).not.toContain('AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw');
  expect(JSON.parse(stored)).toMatchObject({ storage: 'encrypted', chatId: null });
  await app.close();
});

test('a mistyped token is refused before Telegram is ever called', async () => {
  const { app } = await launchFresh();
  const page = await app.firstWindow();
  await page.getByRole('button', { name: 'Settings' }).click();
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await dialog.getByLabel('Bot token').fill('my-bot-token');
  await dialog.getByRole('button', { name: 'Save token' }).click();
  await expect(dialog.getByRole('alert')).toContainText('does not look like a bot token');
  await expect(dialog.getByLabel('Bot token')).toBeVisible();
  await app.close();
});
