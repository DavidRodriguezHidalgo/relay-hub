import { _electron as electron, expect, test } from '@playwright/test';
import { copyFile, mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const fixtures = resolve(__dirname, '../../../packages/engine/test/fixtures');

async function launchWithFixtures(names: string[]) {
  const root = await mkdtemp(join(tmpdir(), 'relay-e2e-'));
  await mkdir(join(root, 'projects', 'p'), { recursive: true });
  for (const name of names) await copyFile(join(fixtures, name), join(root, 'projects', 'p', name));
  return electron.launch({
    args: [resolve(__dirname, '../.vite/build/main.js')],
    env: { ...process.env, RELAY_PROJECTS_DIR: join(root, 'projects') },
  });
}

test('lists sessions from a fixtures dir and opens a transcript', async () => {
  const app = await launchWithFixtures(['no-prompt.jsonl']);
  const page = await app.firstWindow();

  await page.getByLabel('Show stale').check(); // fixture cwd does not exist here
  await page.getByText('Untitled session').click();
  await expect(page.getByLabel('Session panel')).toContainText('/repo/wt-c-moved');
  await app.close();
});

test('a PR link opens in the system browser, never in an app window', async () => {
  const app = await launchWithFixtures(['basic.jsonl']);
  const opened = await app.evaluate(({ shell }) => {
    const calls: string[] = [];
    shell.openExternal = async (url: string) => {
      calls.push(url);
    };
    (globalThis as { __opened?: string[] }).__opened = calls;
    return calls.length;
  });
  expect(opened).toBe(0);
  const page = await app.firstWindow();

  await page.getByLabel('Show stale').check();
  await page.getByText('Add tests for the zero-rate case').click();
  await page.getByRole('link', { name: 'PR #42' }).click();
  await page.waitForTimeout(500);

  expect(app.windows()).toHaveLength(1);
  expect(await app.evaluate(() => (globalThis as { __opened?: string[] }).__opened)).toEqual([
    'https://github.com/org/repo/pull/42',
  ]);
  await expect(page.getByLabel('Session panel')).toContainText('/repo/wt-a');
  await app.close();
});
