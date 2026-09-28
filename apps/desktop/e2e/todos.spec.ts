import { _electron as electron, expect, test } from '@playwright/test';
import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
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

test('a long list leaves the sessions where they can be reached', async () => {
  const root = await mkdtemp(join(tmpdir(), 'relay-todos-many-'));
  await mkdir(join(root, 'projects', 'p'), { recursive: true });
  await copyFile(
    resolve(__dirname, '../../../packages/engine/test/fixtures/basic.jsonl'),
    join(root, 'projects', 'p', 'basic.jsonl'),
  );
  const app = await electron.launch({
    args: [resolve(__dirname, '../.vite/build/main.js'), `--user-data-dir=${join(root, 'userData')}`],
    env: { ...process.env, RELAY_PROJECTS_DIR: join(root, 'projects') },
  });
  const page = await app.firstWindow();
  await page.getByLabel('Show stale').check();
  const box = page.getByLabel('What needs doing');

  for (let i = 1; i <= 20; i++) {
    await box.fill(`Piece of work number ${i}`);
    await box.press('Enter');
    await page.waitForTimeout(60);
  }
  // one with no spaces at all: it must wrap rather than widen the panel
  await box.fill('Supercalifragilisticexpialidociousandthensomemorewordswithoutanyspacesatall');
  await box.press('Enter');
  await page.waitForTimeout(600);

  // the newest is on screen: a staging list that swallows what you just typed is useless
  await expect(page.getByRole('checkbox', { name: /Supercalifragilistic/ })).toBeVisible();

  const panel = await page.locator('.session-list').boundingBox();
  const row = await page.locator('.session-row').first().boundingBox();
  const width = await page.locator('.session-list').evaluate((el) => el.scrollWidth - el.clientWidth);
  expect(panel).not.toBeNull();
  expect(row).not.toBeNull();
  // the whole point of the cap: the first session still sits inside the panel
  expect(row!.y).toBeLessThan(panel!.y + panel!.height);
  // and nothing in the list pushes the panel sideways
  expect(width).toBeLessThanOrEqual(0);
  await app.close();
  await rm(root, { recursive: true, force: true });
});
