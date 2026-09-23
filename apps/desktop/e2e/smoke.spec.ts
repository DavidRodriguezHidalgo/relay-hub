import { _electron as electron, expect, test } from '@playwright/test';
import { copyFile, mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test('lists sessions from a fixtures dir and opens a transcript', async () => {
  const root = await mkdtemp(join(tmpdir(), 'relay-e2e-'));
  await mkdir(join(root, 'projects', 'p'), { recursive: true });
  const fixtures = resolve(__dirname, '../../../packages/engine/test/fixtures');
  await copyFile(join(fixtures, 'no-prompt.jsonl'), join(root, 'projects', 'p', 's-noprompt.jsonl'));

  const app = await electron.launch({
    args: [resolve(__dirname, '../.vite/build/main.js')],
    env: { ...process.env, RELAY_PROJECTS_DIR: join(root, 'projects') },
  });
  const page = await app.firstWindow();

  await page.getByLabel('Show stale').check(); // fixture cwd does not exist here
  await page.getByText('Untitled session').click();
  await expect(page.getByLabel('Session panel')).toContainText('/repo/wt-c-moved');
  await app.close();
});
