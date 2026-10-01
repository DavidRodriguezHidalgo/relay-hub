import { _electron as electron, expect, test, type Page } from '@playwright/test';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const fixtures = resolve(__dirname, '../../../packages/engine/test/fixtures');

/**
 * The basic fixture with enough turns that the panel really scrolls.
 *
 * A header pinned to the top only shows its behaviour against a conversation taller than the
 * panel; with a short one it would pass by sitting still and prove nothing.
 */
async function launchWithLongTranscript(turns: number, opts: { pr?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'relay-e2e-header-'));
  await mkdir(join(root, 'projects', 'p'), { recursive: true });
  const all = (await readFile(join(fixtures, 'basic.jsonl'), 'utf8')).split('\n').filter(Boolean);
  const lines = opts.pr === false ? all.filter((l) => !l.includes('"pr-link"')) : all;
  const padding = Array.from({ length: turns }, (_, i) =>
    JSON.stringify({
      type: 'assistant',
      uuid: `pad-${i}`,
      parentUuid: i === 0 ? 'a1' : `pad-${i - 1}`,
      isSidechain: false,
      timestamp: '2026-09-20T10:02:00.000Z',
      cwd: '/repo/wt-a',
      gitBranch: 'feat/a',
      sessionId: 's-basic',
      message: { role: 'assistant', content: [{ type: 'text', text: `Padding turn ${i} to make the panel scroll.` }] },
    }),
  );
  await writeFile(join(root, 'projects', 'p', 'basic.jsonl'), [...lines, ...padding].join('\n'));
  return electron.launch({
    args: [resolve(__dirname, '../.vite/build/main.js'), `--user-data-dir=${join(root, 'userData')}`],
    env: { ...process.env, RELAY_PROJECTS_DIR: join(root, 'projects') },
  });
}

/**
 * The header must stay clear of the send box, which is pinned to the bottom of the same scroller.
 *
 * That box is `devTools` only (`import.meta.env.DEV`), so a packaged build — which is what CI
 * drives — has no input on this panel at all and nothing to overlap. The check runs where the box
 * exists and says so where it does not, rather than waiting for an element that is never coming.
 */
async function expectClearOfTheSendBox(page: Page, header: { y: number; height: number }) {
  const sendBox = page.locator('.dev-send textarea');
  if ((await sendBox.count()) === 0) return;
  const send = (await sendBox.boundingBox())!;
  expect(header.y + header.height).toBeLessThan(send.y);
}

test('the session header stays at the top of the panel while the conversation scrolls under it', async () => {
  const app = await launchWithLongTranscript(60);
  const page = await app.firstWindow();
  await page.getByLabel('Show stale').check(); // the fixture's cwd does not exist here
  await page.getByText('Add tests for the zero-rate case').click();

  const panel = page.getByLabel('Session panel');
  const bar = page.locator('.session-panel__bar');
  await expect(bar).toBeVisible();

  const atTop = (await bar.boundingBox())!;
  const panelBox = (await panel.boundingBox())!;
  expect(Math.abs(atTop.y - panelBox.y)).toBeLessThan(2);

  // the setup details are visible before scrolling, and are what scrolls away
  await expect(page.locator('.session-panel__detail')).toBeVisible();

  const scrollable = await panel.evaluate((el) => {
    el.scrollTo({ top: el.scrollHeight });
    return { scrollHeight: el.scrollHeight, clientHeight: el.clientHeight, scrollTop: el.scrollTop };
  });
  // if the panel does not actually scroll, nothing below proves anything
  expect(scrollable.scrollHeight).toBeGreaterThan(scrollable.clientHeight + 200);
  expect(scrollable.scrollTop).toBeGreaterThan(200);

  // the setup details have scrolled up past the panel's top edge, under the pinned header
  const detail = (await page.locator('.session-panel__detail').boundingBox())!;
  expect(detail.y + detail.height).toBeLessThanOrEqual(panelBox.y + 1);

  const pinned = (await bar.boundingBox())!;
  expect(Math.abs(pinned.y - panelBox.y)).toBeLessThan(2);
  // one line: a tall block stuck to the top would eat the panel
  expect(pinned.height).toBeLessThan(56);

  await expectClearOfTheSendBox(page, pinned);

  // the things reached for while a session works, all inside the pinned strip
  const strip = bar;
  // without a real agent the model list is empty, so the picker degrades to plain text; either way it is here
  await expect(strip.locator('.model')).toBeVisible();
  await expect(strip.getByRole('link', { name: 'PR #42' })).toBeVisible();
  await expect(strip.getByRole('button', { name: 'Show subagent turns' })).toBeVisible();

  await app.close();
});

test('a session with no pull request simply leaves it out of the header', async () => {
  const app = await launchWithLongTranscript(60, { pr: false });
  const page = await app.firstWindow();
  await page.getByLabel('Show stale').check();
  await page.getByText('Add tests for the zero-rate case').click();

  const panel = page.getByLabel('Session panel');
  const bar = page.locator('.session-panel__bar');
  await panel.evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
  await expect(bar.locator('.model')).toBeVisible();
  await expect(bar.getByRole('link')).toHaveCount(0);

  const pinned = (await bar.boundingBox())!;
  const panelBox = (await panel.boundingBox())!;
  expect(Math.abs(pinned.y - panelBox.y)).toBeLessThan(2);
  expect(pinned.height).toBeLessThan(56);
  await app.close();
});

test('the pinned header stays one line on a narrow window, and still clears the send box', async () => {
  const app = await launchWithLongTranscript(60);
  const page = await app.firstWindow();
  await page.setViewportSize({ width: 900, height: 600 });
  await page.getByLabel('Show stale').check();
  await page.getByText('Add tests for the zero-rate case').click();

  const panel = page.getByLabel('Session panel');
  const bar = page.locator('.session-panel__bar');
  await panel.evaluate((el) => el.scrollTo({ top: el.scrollHeight }));

  const pinned = (await bar.boundingBox())!;
  const panelBox = (await panel.boundingBox())!;
  expect(Math.abs(pinned.y - panelBox.y)).toBeLessThan(2);
  expect(pinned.height).toBeLessThan(56);
  await expectClearOfTheSendBox(page, pinned);
  // everything still there and on one row: the title is what gives way, not the controls
  await expect(bar.locator('.model')).toBeVisible();
  await expect(bar.getByRole('button', { name: 'Show subagent turns' })).toBeVisible();

  await app.close();
});
