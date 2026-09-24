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
    // its own data directory: a test must not read or write the real app's settings
    args: [resolve(__dirname, '../.vite/build/main.js'), `--user-data-dir=${join(root, 'userData')}`],
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
test('renders readably in dark and light', async () => {
  const app = await launchWithFixtures(['basic.jsonl', 'no-prompt.jsonl']);
  const page = await app.firstWindow();
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.getByLabel('Show stale').check();
  await page.getByText('Add tests for the zero-rate case').click();
  for (const theme of ['dark', 'light'] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await page.waitForTimeout(300);
    await page.screenshot({ path: `test-results/relay-${theme}.png` });
    const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    expect(bg).toBe(theme === 'dark' ? 'rgb(11, 11, 11)' : 'rgb(255, 255, 255)');
  }
  await app.close();
});

test('the window can be dragged by its top strip, and controls still take clicks', async () => {
  const app = await launchWithFixtures(['basic.jsonl']);
  const page = await app.firstWindow();
  await page.locator('.titlebar').waitFor(); // the strip only exists once the renderer has mounted
  const regions = await page.evaluate(() => {
    const at = (sel: string) => {
      const el = document.querySelector(sel);
      return el ? getComputedStyle(el).getPropertyValue('-webkit-app-region') : null;
    };
    return { strip: at('.titlebar'), button: at('button'), box: at('textarea') };
  });
  expect(regions.strip).toBe('drag');
  expect(regions.button).toBe('no-drag');
  expect(regions.box).toBe('no-drag');
  await app.close();
});

test("the search row and its stale toggle sit on one line", async () => {
  const app = await launchWithFixtures(["basic.jsonl"]);
  const page = await app.firstWindow();
  await page.locator(".titlebar").waitFor();
  const middles = await page.evaluate(() => {
    const middle = (sel: string) => {
      const box = document.querySelector(sel)!.getBoundingClientRect();
      return box.top + box.height / 2;
    };
    return { search: middle('input[type="search"]'), stale: middle('input[type="checkbox"]') };
  });
  expect(Math.abs(middles.search - middles.stale)).toBeLessThan(2);
  await app.close();
});

test("the Relay name is the focal point of the chat", async () => {
  const app = await launchWithFixtures(["basic.jsonl"]);
  const page = await app.firstWindow();
  await page.locator(".chat__header strong").waitFor();
  const size = await page.evaluate(() =>
    parseFloat(getComputedStyle(document.querySelector(".chat__header strong")!).fontSize),
  );
  expect(size).toBeGreaterThanOrEqual(20);
  await app.close();
});

test('the allow-all toggle ticks, sticks, and survives a restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'relay-e2e-'));
  await mkdir(join(root, 'projects', 'p'), { recursive: true });
  await copyFile(join(fixtures, 'basic.jsonl'), join(root, 'projects', 'p', 'basic.jsonl'));
  const launch = () =>
    electron.launch({
      args: [resolve(__dirname, '../.vite/build/main.js'), `--user-data-dir=${join(root, 'userData')}`],
      env: { ...process.env, RELAY_PROJECTS_DIR: join(root, 'projects') },
    });

  const app = await launch();
  const page = await app.firstWindow();
  await page.getByRole('button', { name: 'Settings' }).click();
  const toggle = page.getByRole('checkbox', { name: /Allow all actions/ });
  await expect(toggle).not.toBeChecked();
  await toggle.click();
  await expect(toggle).toBeChecked();
  await app.close();

  // the choice belongs to the engine, so a new run of the app must still have it on
  const again = await launch();
  const page2 = await again.firstWindow();
  await page2.getByRole('button', { name: 'Settings' }).click();
  await expect(page2.getByRole('checkbox', { name: /Allow all actions/ })).toBeChecked();
  await again.close();
});
