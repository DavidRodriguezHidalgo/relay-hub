# Relay Hub — Milestone 6: Continental look, create sessions

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Relay gets a readable Continental-style look (yellow on near-black, with a light theme) built on Tailwind. You can also ask the orchestrator to create a new Claude session, normally in a fresh git worktree, after it asks which project and branch.

**Architecture:**
- **Look.** Tailwind v4 via `@tailwindcss/vite`. Colours are CSS variables in one `theme.css`: dark by default, light under `prefers-color-scheme: light`. They are exposed to Tailwind through `@theme`. The existing semantic class names stay, now defined with `@apply` in `app.css`, so components and their behaviour tests change only where a button gains a primary style. A unit test parses `theme.css` and checks WCAG AA contrast for every text/background pair in both modes. The Electron e2e test saves dark and light screenshots so the result can actually be looked at.
- **Create session.** The engine gains a `worktrees` module (`git worktree add` for a new branch off `origin/<default>`, with refusals). `RelayEngine` gains `listProjects()` (main-repo roots of the known sessions) and `createSession()`, which starts a fresh session (M3's `resume: null`) under the session profile and registers the runner once its id is known. The orchestrator gets `list_projects` and `create_session` tools, and a prompt rule to ask before creating.

**Tech Stack:** as M5, plus `tailwindcss@4.3.3` and `@tailwindcss/vite@4.3.3` (the newest 4.x past pnpm's release-age cutoff).

**Spec:** `docs/superpowers/specs/2026-09-23-relay-hub-design.md`, "UI". Session creation is new, as agreed in chat on 2026-09-23. The orchestrator asks which project, and the default is a new worktree per branch, in the same layout as `~/code/factorial-worktrees/*`.

## Global Constraints

- Palette (the brand: Continental yellow on black):
  - dark: bg `#0B0B0B`, surface `#151515`, surface-2 `#1E1E1E`, border `#2E2E2E`, text `#F2F2F2`, muted `#A8A8A8`, accent `#FFA500`, accent-text `#FFA500`, on-accent `#000000`, running `#FFA500`, waiting `#FF7AB6`, danger `#FF5C5C`, success `#3DD68C`;
  - light: bg `#FFFFFF`, surface `#F6F6F6`, surface-2 `#ECECEC`, border `#D6D6D6`, text `#111111`, muted `#555555`, accent `#FFA500` (fills only), accent-text `#8A5200`, on-accent `#000000`, running `#8A5200`, waiting `#B0266B`, danger `#C62828`, success `#1E7D46`.
- **Readable first:**
  - Every text colour must reach **4.5:1** against every background it sits on, in both modes. The test enforces this.
  - Yellow is never used as text on a light background.
  - Body text is 14 px; the chat and transcripts are 15 px with line-height 1.55.
- **No behaviour change from the restyle.** All existing tests stay green without edits, except one: the added primary-button class is asserted nowhere, so it needs no change.
- **Worktrees:**
  - location `join(dirname(root), \`${basename(root)}-worktrees\`, slug(branch))`, where `slug` replaces `/` with `-`, so `~/code/factorial` + `feat/x` → `~/code/factorial-worktrees/feat-x`;
  - base `origin/<default branch>` after `git fetch origin <default>`;
  - refuse when the directory exists, when the branch exists locally, or when the root is not a git repo;
  - never check out, reset or otherwise touch the main clone's working tree.
- `create_session` needs a project, which is either a known project name or an absolute path. A new branch is optional: without one, the session runs in the given directory as is, and that directory must exist. The orchestrator must ask for whatever is missing and say in one line what it will create before calling.
- Commits end with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`. No ticket ids in code.

## Review Focus

1. **Light mode readability.** Yellow text on white and muted grey on grey surfaces are the likely failures. The contrast test must cover every pair actually used (Task 1).
2. **A branch name with slashes, or one that already exists.** The worktree directory is slugged, and an existing branch or directory is refused with a clear message rather than a git error dump (Task 3).
3. **A project given by name that matches two repos**, e.g. two clones called `factorial`. `create_session` must refuse and list both paths (Task 4).
4. **The new session's first turn fails** (bad cwd, SDK error before init). `createSession` must reject with the reason within the timeout, and leave no half-registered runner (Task 4).
5. **The created session shows up** in the list and panel as soon as its transcript exists, and turn-end relays reach the orchestrator, because the send's origin is `orchestrator` (Task 4, Task 6).

---

### Task 1: Tailwind, theme tokens, contrast test

**Files:**
- Create: `apps/desktop/src/ui/theme.css`, `apps/desktop/src/ui/app.css`, `apps/desktop/src/ui/theme.test.ts`
- Delete: `apps/desktop/src/ui/styles.css`
- Modify: `apps/desktop/package.json`, `apps/desktop/vite.renderer.config.ts`, `apps/desktop/src/renderer.tsx`

- [ ] **Step 1: Install.** `pnpm --filter @relay/desktop add -D tailwindcss@4.3.3 @tailwindcss/vite@4.3.3`. If `pnpm add` hangs after writing `package.json` (seen before), kill it and run `pnpm install`.

- [ ] **Step 2 (red): contrast test** `theme.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const css = readFileSync(fileURLToPath(new URL('./theme.css', import.meta.url)), 'utf8');

/** `--name: #rrggbb;` pairs inside the first block that follows `marker`. */
function tokens(marker: string): Record<string, string> {
  const start = css.indexOf(marker);
  if (start < 0) throw new Error(`no ${marker} block`);
  const block = css.slice(css.indexOf('{', start) + 1, css.indexOf('}', start));
  return Object.fromEntries([...block.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-fA-F]{6})/g)].map((m) => [m[1]!, m[2]!]));
}

const channel = (v: number) => {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
const luminance = (hex: string) => {
  const n = parseInt(hex.slice(1), 16);
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
};
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
};

/** Every foreground actually used on each background it sits on. */
const PAIRS: [fg: string, bg: string][] = [
  ...['text', 'muted', 'accent-text', 'running', 'waiting', 'danger', 'success'].flatMap((fg) =>
    ['bg', 'surface', 'surface-2'].map((bg) => [fg, bg] as [string, string]),
  ),
  ['on-accent', 'accent'],
];

describe.each([
  ['dark', ':root'],
  ['light', '@media (prefers-color-scheme: light)'],
])('%s theme', (_name, marker) => {
  const t = tokens(marker);
  it.each(PAIRS)('%s on %s reaches WCAG AA (4.5:1)', (fg, bg) => {
    expect(t[fg], `missing --${fg}`).toBeDefined();
    expect(t[bg], `missing --${bg}`).toBeDefined();
    expect(contrast(t[fg]!, t[bg]!)).toBeGreaterThanOrEqual(4.5);
  });
});
```
Run `pnpm --filter @relay/desktop test theme` → FAIL (no `theme.css`).

- [ ] **Step 3: `theme.css`** (tokens only; the test parses it):
```css
/* Continental yellow on black. Every text/background pair is checked by theme.test.ts. */
:root {
  --bg: #0b0b0b;
  --surface: #151515;
  --surface-2: #1e1e1e;
  --border: #2e2e2e;
  --text: #f2f2f2;
  --muted: #a8a8a8;
  --accent: #ffa500;
  --accent-text: #ffa500;
  --on-accent: #000000;
  --running: #ffa500;
  --waiting: #ff7ab6;
  --danger: #ff5c5c;
  --success: #3dd68c;
  color-scheme: dark;
}

@media (prefers-color-scheme: light) {
  :root {
    --bg: #ffffff;
    --surface: #f6f6f6;
    --surface-2: #ececec;
    --border: #d6d6d6;
    --text: #111111;
    --muted: #555555;
    --accent: #ffa500;
    --accent-text: #8a5200;
    --on-accent: #000000;
    --running: #8a5200;
    --waiting: #b0266b;
    --danger: #c62828;
    --success: #1e7d46;
    color-scheme: light;
  }
}
```
Run the test → it now fails only on the pairs that are really too weak, if any. Fix those by darkening (light) or lightening (dark) the offending token, and record each adjustment as a ruling. Do not relax the threshold.

- [ ] **Step 4: `app.css`.** Tailwind plus the semantic classes. It replaces `styles.css` one for one, so every class used in the TSX still exists:
```css
@import 'tailwindcss';
@import './theme.css';

@theme inline {
  --color-bg: var(--bg);
  --color-surface: var(--surface);
  --color-surface-2: var(--surface-2);
  --color-line: var(--border);
  --color-fg: var(--text);
  --color-muted: var(--muted);
  --color-accent: var(--accent);
  --color-accent-fg: var(--accent-text);
  --color-on-accent: var(--on-accent);
  --color-running: var(--running);
  --color-waiting: var(--waiting);
  --color-danger: var(--danger);
  --color-success: var(--success);
  --font-sans: -apple-system, BlinkMacSystemFont, 'Inter', system-ui, sans-serif;
  --font-mono: ui-monospace, 'SF Mono', Menlo, monospace;
}

@layer base {
  html, body, #root { @apply h-full; }
  body { @apply m-0 bg-bg text-fg font-sans text-[14px] leading-[1.45] antialiased; }
  button {
    @apply cursor-pointer rounded-md border border-line bg-surface-2 px-2.5 py-1 text-[13px] text-fg transition-colors
      hover:border-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent
      disabled:cursor-not-allowed disabled:opacity-50;
  }
  input[type='search'], textarea, select {
    @apply rounded-md border border-line bg-surface px-2 py-1.5 text-fg placeholder:text-muted
      focus:border-accent focus:outline-none;
  }
  code { @apply font-mono text-[12px] text-muted; }
  a { @apply text-accent-fg underline-offset-2 hover:underline; }
  ::selection { @apply bg-accent text-on-accent; }
}

@layer components {
  .btn-primary { @apply border-accent bg-accent font-semibold text-on-accent hover:brightness-95; }

  .app { @apply grid h-screen grid-cols-[300px_1fr_440px] bg-bg; }
  .session-list { @apply overflow-auto border-r border-line bg-surface px-2 pt-10 pb-2; }
  .session-list__controls { @apply mb-2 flex items-center gap-2 text-[12px] text-muted; }
  .session-list__controls input[type='search'] { @apply flex-1; }
  .session-list h2 { @apply mx-2 mt-4 mb-1 text-[11px] font-semibold tracking-wider text-muted uppercase; }
  .session-list ul { @apply m-0 list-none p-0; }
  .session-row { @apply block w-full rounded-md border-0 border-l-2 border-transparent bg-transparent px-2 py-1.5 text-left hover:bg-surface-2; }
  .session-row--selected { @apply border-accent bg-surface-2; }
  .session-row__title { @apply block truncate text-[13px]; }
  .session-row__meta { @apply mt-0.5 flex gap-1.5 text-[11px] text-muted; }
  .badge { @apply rounded border border-line px-1 text-[11px] text-fg; }

  .orchestrator { @apply flex min-h-0 flex-col overflow-hidden px-5 pt-10; }
  .session-panel { @apply overflow-auto border-l border-line bg-surface px-4 pt-10 pb-4; }
  .placeholder { @apply text-muted; }

  .transcript { @apply m-0 list-none p-0; }
  .entry { @apply mb-3 rounded-lg px-3 py-2 text-[15px] leading-[1.55]; }
  .entry--user { @apply border border-line bg-surface-2; }
  .entry--sidechain { @apply opacity-70; }
  .entry header { @apply mb-1 flex justify-between gap-2 text-[11px] text-muted; }
  .block-text { @apply m-0 mb-1.5 whitespace-pre-wrap; }
  .block-tool { @apply font-mono text-[12px] text-muted; }
  .block-result summary { @apply cursor-pointer font-mono text-[12px] text-muted; }
  .block-result pre { @apply max-h-60 overflow-auto rounded bg-bg p-2 font-mono text-[12px] text-fg; }
  .block-result--error summary { @apply text-danger; }
  .origin { @apply text-accent-fg italic; }

  .session-panel__header h1 { @apply m-0 mb-1 text-[16px] font-semibold; }
  .session-panel__header p { @apply m-0 mb-2 flex flex-wrap items-center gap-1.5 text-[12px]; }

  .state { @apply rounded-full border px-2 py-px text-[11px] font-medium; }
  .state--idle, .state--proposed, .state--queued, .state--skipped, .state--cancelled { @apply border-line text-muted; }
  .state--running { @apply border-running text-running; }
  .state--waiting-approval { @apply border-waiting text-waiting; }
  .state--error { @apply border-danger text-danger; }
  .state--done, .state--finished { @apply border-success text-success; }
  .dot { @apply mr-1.5 inline-block size-2 rounded-full bg-line align-middle; }
  .dot--running { @apply bg-running; }
  .dot--waiting-approval { @apply bg-waiting; }
  .dot--error { @apply bg-danger; }

  .approval { @apply mb-2.5 rounded-lg border border-waiting bg-surface-2 px-3 py-2; }
  .approval__reason { @apply mb-1 font-semibold text-waiting; }
  .approval__summary { @apply my-1 block font-mono text-[12px] whitespace-pre-wrap text-fg; }
  .approval__meta { @apply text-[11px] text-muted; }
  .approval__actions { @apply mt-2 flex flex-wrap gap-1.5; }

  .error { @apply text-danger; }
  .dev-send { @apply sticky bottom-0 bg-surface pt-2; }
  .dev-send textarea { @apply w-full; }
  .dev-send__row { @apply mt-1 flex gap-1.5; }

  .approvals-drawer { @apply sticky bottom-0 mt-auto border-t border-waiting bg-bg pt-2 pb-2; }
  .approvals-drawer h2 { @apply m-0 mb-2 text-[12px] font-semibold text-waiting; }
  .link { @apply mb-1 border-0 bg-transparent p-0 text-accent-fg underline; }

  .chat { @apply min-h-0 flex-1 overflow-auto pr-1; }
  .chat__header { @apply mb-3 flex items-center gap-2 text-[15px]; }
  .chat__header strong { @apply text-accent-fg; }
  .relay-update { @apply my-1 mb-3 border-l-2 border-accent pl-2 text-[12px] text-muted; }
  .chat-input { @apply bg-bg py-3; }
  .chat-input textarea { @apply w-full text-[15px]; }

  .bulk-card { @apply mb-3 rounded-lg border border-line bg-surface px-3 py-2; }
  .bulk-card h3 { @apply m-0 mb-2 text-[13px] font-semibold; }
  .bulk-card ul { @apply m-0 list-none p-0; }
  .bulk-card li { @apply mb-1.5; }
  .bulk-card__prompt, .bulk-card__detail { @apply mt-0.5 ml-6 text-[12px] whitespace-pre-wrap text-muted; }
  .bulk-card__actions { @apply mt-2 flex gap-1.5; }

  .gh-banner { @apply fixed inset-x-0 top-0 z-10 bg-accent px-3 py-1 text-center text-[12px] font-semibold text-on-accent; }
  .watch { @apply text-[11px] text-muted; }
}
```
`renderer.tsx`: replace `import './ui/styles.css';` with `import './ui/app.css';`. Delete `styles.css`. `vite.renderer.config.ts`: `plugins: [react(), tailwindcss()]` with `import tailwindcss from '@tailwindcss/vite';`.

- [ ] **Step 5:** `pnpm --filter @relay/desktop test && pnpm typecheck` → green. `pnpm --filter @relay/desktop start` builds and the renderer loads. Watch the log for Tailwind errors: an unknown utility in `@apply` fails the build loudly. Commit `feat(desktop): Tailwind with Continental theme tokens and a contrast check`.

---

### Task 2: Primary actions and screenshots

**Files:** Modify `apps/desktop/src/ui/SessionPanel.tsx`, `OrchestratorChat.tsx`, `BulkRunCard.tsx`, `ApprovalCard.tsx`, `apps/desktop/e2e/smoke.spec.ts`, `.gitignore`.

- [ ] **Step 1:** Add `className="btn-primary"` to the one main action in each place: **Send** (dev box), **Run on N sessions**, **Allow once**, **Watch PR**. The chat has no button, since Enter sends. Leave Deny / Cancel / Interrupt as default buttons, so there's only one yellow action per group.
- [ ] **Step 2: Screenshot e2e.** Append to `smoke.spec.ts`:
```ts
test('renders readably in dark and light', async () => {
  const app = await launchWithFixtures(['basic.jsonl', 'no-prompt.jsonl']);
  const page = await app.firstWindow();
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.getByLabel('Show stale').check();
  await page.getByText('Add tests for the zero-rate case').click();
  for (const theme of ['dark', 'light'] as const) {
    await app.evaluate(({ nativeTheme }, t) => { nativeTheme.themeSource = t; }, theme);
    await page.waitForTimeout(300);
    await page.screenshot({ path: `test-results/relay-${theme}.png` });
    const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    expect(bg).toBe(theme === 'dark' ? 'rgb(11, 11, 11)' : 'rgb(255, 255, 255)');
  }
  await app.close();
});
```
(`test-results/` is already gitignored.) Run `pnpm --filter @relay/desktop test:e2e` → 3 passed. **Look at both PNGs** (`apps/desktop/test-results/relay-dark.png`, `relay-light.png`) and fix anything unreadable or broken. Record what was changed as rulings.
- [ ] **Step 3:** Commit `feat(desktop): primary actions in Continental yellow; dark and light screenshots`.

---

### Task 3: Worktrees

**Files:** Create `packages/engine/src/git/worktrees.ts`; test `packages/engine/test/git/worktrees.test.ts`.

**Interfaces — produces:**
```ts
export function worktreePath(root: string, branch: string): string;
export async function repoRoot(cwd: string): Promise<string | null>;         // main repo root (parent of the common git dir)
export async function createWorktree(root: string, branch: string): Promise<string>;  // returns the new directory
```

- [ ] **Step 1 (red):** use a real temporary repo with a local "origin", like M1's git-info test:
```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createWorktree, repoRoot, worktreePath } from '../../src/git/worktrees';

const run = promisify(execFile);
const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const git = (cwd: string, ...args: string[]) => run('git', ['-C', cwd, ...args], { env });

describe('worktrees', () => {
  let root: string;
  let clone: string;
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'relay-wt-'));
    const origin = join(root, 'origin.git');
    await run('git', ['init', '-q', '--bare', '-b', 'main', origin]);
    clone = join(root, 'code', 'myrepo');
    await mkdir(join(root, 'code'));
    await run('git', ['clone', '-q', origin, clone], { env });
    await git(clone, 'commit', '-q', '--allow-empty', '-m', 'init');
    await git(clone, 'push', '-q', 'origin', 'main');
  });
  afterAll(() => rm(root, { recursive: true, force: true }));

  it('places worktrees next to the repo, slugging the branch', () => {
    expect(worktreePath('/Users/me/code/factorial', 'feat/mileage-v2')).toBe('/Users/me/code/factorial-worktrees/feat-mileage-v2');
  });

  it('finds the main repo root from the repo or any of its worktrees', async () => {
    expect(await repoRoot(clone)).toBe(clone);
    expect(await repoRoot(tmpdir())).toBeNull();
  });

  it('creates a worktree on a new branch off origin/main, without touching the main checkout', async () => {
    const dir = await createWorktree(clone, 'feat/x');
    expect(dir).toBe(join(root, 'code', 'myrepo-worktrees', 'feat-x'));
    expect((await stat(dir)).isDirectory()).toBe(true);
    expect((await git(dir, 'rev-parse', '--abbrev-ref', 'HEAD')).stdout.trim()).toBe('feat/x');
    expect((await git(clone, 'rev-parse', '--abbrev-ref', 'HEAD')).stdout.trim()).toBe('main');
    expect(await repoRoot(dir)).toBe(clone);
  });

  it('refuses an existing branch or directory, and a non-repo root, with a clear message', async () => {
    await expect(createWorktree(clone, 'feat/x')).rejects.toThrow(/branch feat\/x already exists/);
    await git(clone, 'branch', 'feat/y');
    await expect(createWorktree(clone, 'feat/y')).rejects.toThrow(/branch feat\/y already exists/);
    await mkdir(join(root, 'code', 'myrepo-worktrees', 'feat-z'), { recursive: true });
    await expect(createWorktree(clone, 'feat/z')).rejects.toThrow(/already exists: .*feat-z/);
    await expect(createWorktree(tmpdir(), 'feat/q')).rejects.toThrow(/not a git repository/);
  });
});
```
Run → FAIL.
- [ ] **Step 2:** Implementation:
```ts
import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await run('git', ['-C', cwd, ...args], { timeout: 120_000 });
    return stdout.trim();
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr?.trim();
    throw new Error(`git ${args[0]} failed${stderr ? `: ${stderr}` : ''}`);
  }
}

const exists = (p: string) => access(p).then(() => true, () => false);

/** `~/code/factorial` + `feat/x` → `~/code/factorial-worktrees/feat-x`. */
export function worktreePath(root: string, branch: string): string {
  return join(dirname(root), `${basename(root)}-worktrees`, branch.replaceAll('/', '-'));
}

/** The main repository root for a repo or any of its worktrees; null outside git. */
export async function repoRoot(cwd: string): Promise<string | null> {
  try {
    const common = await git(cwd, ['rev-parse', '--git-common-dir']);
    return dirname(resolve(cwd, common));
  } catch {
    return null;
  }
}

async function defaultBranch(root: string): Promise<string> {
  try {
    return (await git(root, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])).replace(/^origin\//, '');
  } catch {
    return 'main';
  }
}

/** A new worktree on a new branch off the freshly fetched default branch; the main checkout is untouched. */
export async function createWorktree(root: string, branch: string): Promise<string> {
  if ((await repoRoot(root)) === null) throw new Error(`${root} is not a git repository`);
  const dir = worktreePath(root, branch);
  if (await exists(dir)) throw new Error(`Worktree directory already exists: ${dir}`);
  const known = await git(root, ['branch', '--list', branch]);
  if (known !== '') throw new Error(`The branch ${branch} already exists; pick another name or use its worktree`);
  const base = await defaultBranch(root);
  await git(root, ['fetch', '-q', 'origin', base]);
  await git(root, ['worktree', 'add', '-q', '-b', branch, dir, `origin/${base}`]);
  return dir;
}
```
(`^origin\/` strips a fixed prefix from git's own output. It isn't agent-behaviour routing.)
- [ ] **Step 3:** → PASS; typecheck. Commit `feat(engine): create git worktrees for new sessions`.

---

### Task 4: Projects and createSession in the engine

**Files:** Modify `packages/engine/src/relay-engine.ts`, `packages/engine/src/index.ts`; test `packages/engine/test/relay-engine.test.ts`.

**Interfaces:**
- Consumes: `repoRoot`, `createWorktree` (Task 3); `SessionRunner` with `resume: null` (M3).
- Produces:
  ```ts
  RelayEngineOptions += { worktrees?: { repoRoot(cwd: string): Promise<string | null>; createWorktree(root: string, branch: string): Promise<string> }; createTimeoutMs?: number }
  RelayEngine.listProjects(): Promise<{ name: string; root: string; sessions: number }[]>   // distinct roots of listed sessions whose cwd exists
  RelayEngine.createSession(req: { project: string; branch?: string; prompt: string; origin: MessageOrigin }): Promise<{ sessionId: string; cwd: string }>
  ```
  Behaviour:
  - `project` is an absolute path, or a project name matched against `listProjects()`. Several matches → throw `Several projects are called <name>: <root1>, <root2>`. No match → `Unknown project <name>`.
  - With `branch`: `cwd = await createWorktree(root, branch)`. Without: `cwd = root` for a name, or the given absolute path, which must exist.
  - Start: `new SessionRunner({ sessionId: pendingKey, resume: null, cwd, client, approvals, profile: { kind: 'session' } })` with `pendingKey = \`new:${uuid}\``, then `send(prompt, { mode: 'steer', origin })`. Wait for `session-id` up to `createTimeoutMs` (default 60 s). On the id, register the runner under it with the same wiring as `createRunner` (state/entry/turn-end/bulk/relay/idle), publish its current state, and resolve `{ sessionId, cwd }`.
  - If the runner reports `error` before the id arrives, or the timeout fires: close it, and reject with `Could not start a session in <cwd>: <reason>`. A worktree created for it stays: it's cheap, and the reason may be fixable.
  - Refactor: pull the runner wiring out of `createRunner` into `private wire(sessionId: string, runner: SessionRunner, session: { title: string; branch: string | null; id: string }): void`, so both paths share it. The relay needs a title before the index has seen the file: use the first 80 chars of the prompt, and the branch.

- [ ] **Step 1 (red):**
```ts
  function fakeWorktrees(roots: Record<string, string>) {
    const created: string[] = [];
    return {
      created,
      repoRoot: async (cwd: string) => roots[cwd] ?? null,
      createWorktree: async (root: string, branch: string) => {
        const dir = join(root + '-worktrees', branch.replaceAll('/', '-'));
        await mkdir(dir, { recursive: true });
        created.push(dir);
        return dir;
      },
    };
  }

  it('lists projects as the distinct repo roots of existing sessions', async () => {
    const wt = fakeWorktrees({});
    await startWithBasic(new FakeAgentClient(), undefined, { more: true, worktrees: wt });
    wt.repoRoot = async (cwd: string) => (cwd.endsWith('wt-a') || cwd.endsWith('wt-b') ? join(root, 'myrepo') : null);
    expect(await engine!.listProjects()).toEqual([{ name: 'myrepo', root: join(root, 'myrepo'), sessions: 2 }]);
  });

  it('creates a worktree session, registers it under its real id, and relays its turn end to the orchestrator', async () => {
    const orchClient = new FakeAgentClient();
    const sessionClient = new FakeAgentClient();
    const router: AgentClient = {
      start: (opts) => (opts.profile?.kind === 'orchestrator' ? orchClient : sessionClient).start(opts),
    };
    const wt = fakeWorktrees({});
    await startWithBasic(router, undefined, { worktrees: wt });
    const repo = join(root, 'myrepo');
    await mkdir(repo);
    wt.repoRoot = async (cwd: string) => (cwd.endsWith('wt-a') ? repo : null);
    await engine!.orchestratorSend('make a session');
    await tick();
    const creating = engine!.createSession({ project: 'myrepo', branch: 'feat/new', prompt: 'Add a README', origin: 'orchestrator' });
    for (let i = 0; !sessionClient.lastOpts && i < 100; i += 1) await tick();
    expect(sessionClient.lastOpts).toMatchObject({ sessionId: null, cwd: join(repo + '-worktrees', 'feat-new'), profile: { kind: 'session' } });
    sessionClient.init('new-session-1');
    const created = await creating;
    expect(created).toEqual({ sessionId: 'new-session-1', cwd: join(repo + '-worktrees', 'feat-new') });
    expect(engine!.runState().states['new-session-1']).toEqual({ state: 'running', error: null });
    sessionClient.assistant('a1', 'README added.');
    sessionClient.result();
    await tick();
    expect(orchClient.received.filter((m) => m.origin === 'watch:turn-end').map((m) => m.text)).toEqual([
      '[turn-end] session "Add a README" (new-session-1, feat/new) finished. Last reply: README added.',
    ]);
  });

  it('refuses an ambiguous or unknown project name', async () => {
    const wt = fakeWorktrees({});
    await startWithBasic(new FakeAgentClient(), undefined, { more: true, worktrees: wt });
    wt.repoRoot = async (cwd: string) => (cwd.endsWith('wt-a') ? join(root, 'a', 'factorial') : cwd.endsWith('wt-b') ? join(root, 'b', 'factorial') : null);
    await expect(engine!.createSession({ project: 'factorial', prompt: 'x', origin: 'user' })).rejects.toThrow(
      /Several projects are called factorial: .*a\/factorial, .*b\/factorial/,
    );
    await expect(engine!.createSession({ project: 'nope', prompt: 'x', origin: 'user' })).rejects.toThrow(/Unknown project nope/);
  });

  it('rejects with the reason when the new session fails before it has an id, leaving nothing registered', async () => {
    const client = new FakeAgentClient();
    const wt = fakeWorktrees({});
    await startWithBasic(client, undefined, { worktrees: wt, createTimeoutMs: 2_000 });
    const dir = join(root, 'plain');
    await mkdir(dir);
    const creating = engine!.createSession({ project: dir, prompt: 'x', origin: 'user' });
    for (let i = 0; !client.lastOpts && i < 100; i += 1) await tick();
    client.result('error_during_execution: boom');
    await expect(creating).rejects.toThrow(`Could not start a session in ${dir}: error_during_execution: boom`);
    expect(Object.keys(engine!.runState().states)).toEqual([]);
  });
```
`startWithBasic`'s `extra` gains `worktrees?` and `createTimeoutMs?`, both passed through to `RelayEngine.start`. Run → FAIL.
- [ ] **Step 2:** Implement as described. `listProjects`:
  - for each listed session with `cwdExists`, `await worktrees.repoRoot(session.cwd)`, deduped by cwd;
  - group by root and count sessions;
  - `name = basename(root)`;
  - sort by name.

  Default `worktrees` = `{ repoRoot, createWorktree }` from Task 3. Export the engine types from `index.ts`.
- [ ] **Step 3:** `pnpm --filter @relay/engine test && pnpm typecheck` → green (existing tests unchanged). Commit `feat(engine): list projects and create sessions, in a new worktree or an existing directory`.

---

### Task 5: Orchestrator tools

**Files:** Modify `packages/engine/src/orchestrator/relay-tools.ts`, `system-prompt.ts`, `packages/engine/src/relay-engine.ts`; test `packages/engine/test/orchestrator/relay-tools.test.ts`.

**Interfaces — produces:** `RelayToolDeps += { listProjects(): Promise<{ name: string; root: string; sessions: number }[]>; createSession(req: { project: string; branch?: string; prompt: string }): Promise<{ sessionId: string; cwd: string }> }`. Tools `list_projects {}` and `create_session { project: string, branch?: string, prompt: string }`, which returns `{ created: true, sessionId, cwd }`. The engine passes `origin: 'orchestrator'` and applies `refuseRelayOnly()`.

- [ ] **Step 1 (red):** extend `deps()` with `listProjects: vi.fn(async () => [{ name: 'factorial', root: '/code/factorial', sessions: 3 }])` and `createSession: vi.fn(async () => ({ sessionId: 'n1', cwd: '/code/factorial-worktrees/feat-x' }))`. The "exposes exactly" list ends with `'list_projects', 'create_session'`. Add:
```ts
  it('list_projects and create_session call through; failures are tool errors', async () => {
    const d = deps();
    expect(JSON.parse((await call(d, 'list_projects', {})).text)).toEqual([{ name: 'factorial', root: '/code/factorial', sessions: 3 }]);
    const r = await call(d, 'create_session', { project: 'factorial', branch: 'feat/x', prompt: 'Add tests' });
    expect(d.createSession).toHaveBeenCalledWith({ project: 'factorial', branch: 'feat/x', prompt: 'Add tests' });
    expect(JSON.parse(r.text)).toEqual({ created: true, sessionId: 'n1', cwd: '/code/factorial-worktrees/feat-x' });
    const bad = deps({ createSession: async () => { throw new Error('The branch feat/x already exists; pick another name or use its worktree'); } });
    expect(await call(bad, 'create_session', { project: 'factorial', branch: 'feat/x', prompt: 'x' })).toMatchObject({ isError: true });
  });
```
Run → FAIL.
- [ ] **Step 2:** Implement both tools in the same style as the others. The engine wires `listProjects: () => this.listProjects()`, and `createSession: async (req) => { this.refuseRelayOnly(); return this.createSession({ ...req, origin: 'orchestrator' }); }`.
  In the system prompt, add both tools to the tool list, plus:
  `- To start a new session, use create_session. You need the project (ask the user, offering list_projects) and, normally, a new branch name for a fresh worktree (ask for it; suggest one from the task). Say in one line what you will create (project, branch, directory) before calling. Without a branch the session starts in the project directory itself — only do that when the user says so.`
- [ ] **Step 3:** green. Commit `feat(engine): orchestrator can list projects and create sessions`.

---

### Task 6: Live check, README

**Files:** Modify `packages/engine/test/live/sdk-live.test.ts`, `README.md`.

- [ ] **Step 1:** A live case, gated like the others, that creates a real session in a fresh worktree of the scratch repo and gets its first reply. It costs one short turn:
```ts
  it('creates a session in a new worktree of the scratch repo and gets its first reply', async () => {
    const branch = `relay-live-${Date.now()}`;
    const created = await engine.createSession({
      project: '/private/tmp/relay-scratch', branch, prompt: 'Reply with exactly the word: born', origin: 'user',
    });
    expect(created.cwd).toBe(`/private/tmp/relay-scratch-worktrees/${branch}`);
    await waitFor(() => events.some((e) => e.type === 'entry' && e.sessionId === created.sessionId && e.entry.role === 'assistant'), 180_000);
    expect(texts().join('\n').toLowerCase()).toContain('born');
  }, 300_000);
```
The scratch repo has no `origin`, so first give it one: `git -C /tmp/relay-scratch remote add origin /tmp/relay-scratch-origin.git` after `git init --bare -b main /tmp/relay-scratch-origin.git && git -C /tmp/relay-scratch push -q origin main`. Record that setup in the commit message. Run with `RELAY_LIVE=-private-tmp-relay-scratch pnpm --filter @relay/engine test live -t "new worktree"` → PASS.
- [ ] **Step 2:** In the README, a "Look" note (Continental yellow on black; follows macOS light/dark) and a "Creating sessions (M6)" paragraph covering what the orchestrator asks, where worktrees go, and that it never touches the main checkout.
- [ ] **Step 3:** Commit `docs: new look and creating sessions; live check`.
