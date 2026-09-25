import { _electron as electron, expect, test } from '@playwright/test';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

async function launch() {
  const root = await mkdtemp(join(tmpdir(), 'relay-todos-'));
  await mkdir(join(root, 'projects', 'p'), { recursive: true });
  return electron.launch({
    args: [resolve(__dirname, '../.vite/build/main.js'), `--user-data-dir=${join(root, 'userData')}`],
    env: { ...process.env, RELAY_PROJECTS_DIR: join(root, 'projects') },
  });
}

test('the todo list is in the left panel and takes work you type in', async () => {
  const app = await launch();
  const page = await app.firstWindow();

  const box = page.getByLabel('What needs doing');
  await expect(box).toBeVisible();

  await box.fill('Activity log on vacancies');
  await box.press('Enter');

  // it survives the round trip through the engine and its store, not just React state
  await expect(page.getByRole('checkbox', { name: 'Activity log on vacancies' })).toBeVisible();
  await expect(page.getByRole('button', { name: /start a session|choose a project/i })).toBeVisible();
  await app.close();
});
