# Relay Hub — Milestone 5: PR watches

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Relay watches the pull request behind a session: it polls `gh` in code (no tokens) and wakes the session with the event when CI fails, a review comment arrives, or the PR falls behind or into conflict; a merged PR closes the watch. The orchestrator can list your PRs and start/stop watches; quitting with sessions running asks first.

**Architecture:** A `GhClient` interface (exec implementation over the `gh` CLI, fake in tests) feeds pure snapshot/diff functions (`pr/snapshot.ts`). `PrWatcher` owns the watches, polls on an interval, keeps the last snapshot per watch in the Store, and emits `PrEvent`s. `RelayEngine` turns events into queued wake-ups for the session, publishes watch state and events, and exposes `list_prs` / `create_watch` / `delete_watch` to the orchestrator. The desktop app adds a "Watch PR" control, a `gh` banner, native notifications and the quit confirmation.

**Tech Stack:** as M4, plus the `gh` CLI (2.x) on `PATH`, logged in.

**Spec:** `docs/superpowers/specs/2026-09-23-relay-hub-design.md` — "PrWatcher", "PR watch" data flow, `list_prs` / `create_watch` / `delete_watch`, "Error handling" (`gh` offline; quit with sessions running).

## Global Constraints

- Polling is code, never the model: default interval 5 minutes (`PR_POLL_INTERVAL_MS = 300_000`), injectable.
- Events: `ci_failed`, `review_comment`, `base_moved`, `merged`. Definitions (deliberate, recorded here once):
  - `ci_failed` — a check on the **current head commit** has a failing conclusion (`FAILURE`, `TIMED_OUT`, `CANCELLED`, `ACTION_REQUIRED`, `STARTUP_FAILURE`, or a status context in `FAILURE`/`ERROR`) that was not failing in the previous snapshot of the same head. A new push resets the set.
  - `review_comment` — a review or PR comment newer than the previous snapshot whose author is not the viewer (`gh api user`), not a login ending in `[bot]`, and not in `BOT_LOGINS = ['github-actions', 'dependabot', 'codecov', 'renovate', 'vercel', 'netlify', 'sonarcloud', 'linear']`. GitHub does not flag every bot, so the list is explicit.
  - `base_moved` — `mergeable` becomes `CONFLICTING` or `mergeStateStatus` becomes `BEHIND` (from anything else). A base that merely gains commits does not wake a session: in a busy monorepo that would be every few minutes.
  - `merged` — `state` becomes `MERGED`; the watch closes itself. A `CLOSED` (not merged) PR also closes the watch, without waking.
- The first poll of a watch only records a baseline; it never wakes.
- Wakes use `send` with mode `queue` and origin `` `watch:${kind}` ``; they never go to the orchestrator (the M3 relay ignores `watch:*`). A refused wake (session busy elsewhere) is not retried; the event is still published and notified, and the watch's `lastError` says why.
- A failed `gh` call records `lastError` on the watch and sets the engine's `gh` status to `unavailable` with the message; it never produces events and never replaces the stored snapshot. The next successful poll sets it back to `ok`.
- Watches and their last snapshot persist in the Store (table `pr_watches`); on start they resume polling.
- One active watch per session.
- Commits end with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`. No ticket ids in code.

## Review Focus

1. **The same failing check seen on every poll.** It must wake once, not every 5 minutes (Task 3).
2. **A push that fixes CI, then fails again.** A new head commit resets the failure set, so the new failure wakes again (Task 3).
3. **The user's own comment, or a bot's.** Must not wake the session (Task 3).
4. **`gh` logged out or offline mid-watch.** No events, snapshot kept, status `unavailable`, recovery on the next good poll without a burst of stale events (Task 5).
5. **A session with no PR, or whose branch has none.** `create_watch` must say so plainly, not create a watch that polls nothing (Task 6).

---

### Task 1: Shared contract

**Files:** Modify `packages/shared/src/runner.ts`, `packages/shared/src/ipc.ts`, `packages/shared/src/index.ts`; stubs in `apps/desktop/src/preload.ts`, `apps/desktop/src/ui/App.test.tsx`, `apps/desktop/src/ui/useRunState.ts`, `packages/engine/src/relay-engine.ts`, `packages/engine/test/orchestrator/relay-tools.test.ts`.

**Interfaces — produces:**
```ts
export type PrEventKind = 'ci_failed' | 'review_comment' | 'base_moved' | 'merged';
export interface PrEvent { kind: PrEventKind; summary: string; details: string }
export interface PrWatch {
  id: string;
  sessionId: string;
  repo: string;          // owner/name
  prNumber: number;
  prUrl: string;
  active: boolean;
  createdAt: string;
  lastPolledAt: string | null;
  lastError: string | null;
}
export type GhStatus = { state: 'ok' } | { state: 'unavailable'; message: string };
RunnerEvent += { type: 'watch'; watch: PrWatch; gh: GhStatus } | { type: 'pr-event'; sessionId: string; watchId: string; event: PrEvent }
RunState += { watches: PrWatch[]; gh: GhStatus }
IPC.watchCreate = 'relay:watchCreate', IPC.watchDelete = 'relay:watchDelete', IPC.activeSessions = 'relay:activeSessions'
RelayApi.watchCreate(sessionId: string): Promise<PrWatch>
RelayApi.watchDelete(watchId: string): Promise<void>
```
(`activeSessions` is main-process only — used by the quit dialog, not exposed on `RelayApi`.)

- [ ] **Step 1:** Add the types, export them, add the IPC channels and the two `RelayApi` members.
- [ ] **Step 2 (red):** `pnpm typecheck` → FAIL (preload, test fakes, `runState()`, `useRunState` switch).
- [ ] **Step 3:** Stubs: preload `watchCreate: (sessionId) => ipcRenderer.invoke(IPC.watchCreate, sessionId)`, `watchDelete: (watchId) => ipcRenderer.invoke(IPC.watchDelete, watchId)`; test fakes add `watchCreate`/`watchDelete` `vi.fn()` and `runState` resolves `{ states: {}, approvals: [], bulkRuns: [], watches: [], gh: { state: 'ok' } }`; engine `runState()` returns `watches: [], gh: { state: 'ok' }` for now; relay-tools test `runState` adds the same two fields; `useRunState` gets `case 'watch': case 'pr-event': return v;` for now.
- [ ] **Step 4:** `pnpm typecheck && pnpm test` → green. Commit `feat(shared): PR watch contract`.

---

### Task 2: GhClient

**Files:** Create `packages/engine/src/pr/gh-client.ts`; test `packages/engine/test/pr/gh-client.test.ts`.

**Interfaces — produces:**
```ts
export interface PrData {
  number: number; url: string; title: string; state: 'OPEN' | 'CLOSED' | 'MERGED';
  headRefName: string; headRefOid: string; baseRefName: string;
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';
  mergeStateStatus: string;
  checks: { name: string; conclusion: string | null; status: string | null }[];   // CheckRun and StatusContext unified
  feedback: { id: string; author: string; body: string; at: string }[];          // reviews (with a body or a non-COMMENTED state) + comments
}
export interface PrRef { repo: string; number: number; url: string }
export interface GhClient {
  viewer(): Promise<string>;
  viewPr(repo: string, number: number): Promise<PrData>;
  findPrForBranch(cwd: string, branch: string): Promise<PrRef | null>;
  listMyPrs(): Promise<(PrRef & { title: string; headRefName: string; state: string })[]>;
}
export type RunGh = (args: string[], opts?: { cwd?: string }) => Promise<string>;   // stdout
export class ExecGhClient implements GhClient { constructor(run?: RunGh) }
export function repoFromPrUrl(url: string): string | null   // https://github.com/o/r/pull/1 → 'o/r'
```

- [ ] **Step 1 (red):** tests with an injected `RunGh` that records args and returns canned JSON:
```ts
import { describe, expect, it } from 'vitest';
import { ExecGhClient, repoFromPrUrl, type RunGh } from '../../src/pr/gh-client';

function fake(responses: Record<string, unknown>) {
  const calls: { args: string[]; cwd?: string }[] = [];
  const run: RunGh = async (args, opts) => {
    calls.push({ args, cwd: opts?.cwd });
    const key = args.slice(0, 2).join(' ');
    if (!(key in responses)) throw new Error(`gh ${args.join(' ')} failed`);
    return typeof responses[key] === 'string' ? (responses[key] as string) : JSON.stringify(responses[key]);
  };
  return { run, calls };
}

describe('ExecGhClient', () => {
  it('views a PR and unifies checks and feedback', async () => {
    const { run, calls } = fake({
      'pr view': {
        number: 7, url: 'https://github.com/o/r/pull/7', title: 'Mileage', state: 'OPEN',
        headRefName: 'feat/m', headRefOid: 'abc', baseRefName: 'main', mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN',
        statusCheckRollup: [
          { __typename: 'CheckRun', name: 'test', conclusion: 'FAILURE', status: 'COMPLETED' },
          { __typename: 'StatusContext', context: 'ci/legacy', state: 'ERROR' },
        ],
        reviews: [
          { id: 'R1', author: { login: 'ana' }, body: '', state: 'APPROVED', submittedAt: '2026-09-23T10:00:00Z' },
          { id: 'R2', author: { login: 'ana' }, body: '', state: 'COMMENTED', submittedAt: '2026-09-23T10:01:00Z' },
        ],
        comments: [{ id: 'C1', author: { login: 'bob' }, body: 'nit', createdAt: '2026-09-23T10:02:00Z' }],
      },
    });
    const pr = await new ExecGhClient(run).viewPr('o/r', 7);
    expect(calls[0]!.args.slice(0, 5)).toEqual(['pr', 'view', '7', '--repo', 'o/r']);
    expect(pr.checks).toEqual([
      { name: 'test', conclusion: 'FAILURE', status: 'COMPLETED' },
      { name: 'ci/legacy', conclusion: 'ERROR', status: 'COMPLETED' },
    ]);
    expect(pr.feedback).toEqual([
      { id: 'R1', author: 'ana', body: 'APPROVED', at: '2026-09-23T10:00:00Z' },
      { id: 'C1', author: 'bob', body: 'nit', at: '2026-09-23T10:02:00Z' },
    ]);
  });

  it('finds the PR for a branch from the session cwd, or null', async () => {
    const { run, calls } = fake({ 'pr list': [{ number: 3, url: 'https://github.com/o/r/pull/3' }] });
    expect(await new ExecGhClient(run).findPrForBranch('/repo', 'feat/x')).toEqual({ repo: 'o/r', number: 3, url: 'https://github.com/o/r/pull/3' });
    expect(calls[0]).toMatchObject({ cwd: '/repo', args: ['pr', 'list', '--head', 'feat/x', '--state', 'open', '--json', 'number,url', '--limit', '1'] });
    const none = fake({ 'pr list': [] });
    expect(await new ExecGhClient(none.run).findPrForBranch('/repo', 'feat/x')).toBeNull();
  });

  it('reads the viewer login and lists my open PRs', async () => {
    const { run } = fake({
      'api user': 'davidr\n',
      'search prs': [{ number: 1, url: 'https://github.com/o/r/pull/1', title: 'A', headRefName: 'a', state: 'open' }],
    });
    const gh = new ExecGhClient(run);
    expect(await gh.viewer()).toBe('davidr');
    expect(await gh.listMyPrs()).toEqual([{ repo: 'o/r', number: 1, url: 'https://github.com/o/r/pull/1', title: 'A', headRefName: 'a', state: 'open' }]);
  });

  it('propagates gh failures', async () => {
    await expect(new ExecGhClient(fake({}).run).viewPr('o/r', 1)).rejects.toThrow(/gh pr view/);
  });
});

describe('repoFromPrUrl', () => {
  it('extracts owner/name', () => {
    expect(repoFromPrUrl('https://github.com/factorialco/factorial/pull/115760')).toBe('factorialco/factorial');
    expect(repoFromPrUrl('not a url')).toBeNull();
  });
});
```
Run → FAIL.
- [ ] **Step 2:** Implementation:
```ts
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const VIEW_FIELDS =
  'number,url,title,state,headRefName,headRefOid,baseRefName,mergeable,mergeStateStatus,statusCheckRollup,reviews,comments';

export interface PrData { ... as above ... }
export interface PrRef { repo: string; number: number; url: string }
export interface GhClient { ... as above ... }
export type RunGh = (args: string[], opts?: { cwd?: string }) => Promise<string>;

const defaultRun: RunGh = async (args, opts) => {
  const { stdout } = await exec('gh', args, { cwd: opts?.cwd, timeout: 30_000, maxBuffer: 20 * 1024 * 1024 });
  return stdout;
};

export function repoFromPrUrl(url: string): string | null {
  try {
    const parts = new URL(url).pathname.split('/').filter(Boolean);
    return parts.length >= 2 && parts[2] === 'pull' ? `${parts[0]}/${parts[1]}` : null;
  } catch {
    return null;
  }
}

type RawCheck = { __typename?: string; name?: string; context?: string; conclusion?: string | null; status?: string | null; state?: string };
type RawFeedback = { id: string; author?: { login?: string }; body?: string; state?: string; submittedAt?: string; createdAt?: string };

/** Talks to GitHub through the `gh` CLI, so it uses the user's own login. */
export class ExecGhClient implements GhClient {
  constructor(private readonly run: RunGh = defaultRun) {}

  async viewer(): Promise<string> {
    return (await this.run(['api', 'user', '--jq', '.login'])).trim();
  }

  async viewPr(repo: string, number: number): Promise<PrData> {
    const raw = JSON.parse(await this.run(['pr', 'view', String(number), '--repo', repo, '--json', VIEW_FIELDS])) as Record<string, unknown>;
    const checks = ((raw.statusCheckRollup as RawCheck[] | null) ?? []).map((c) =>
      c.__typename === 'StatusContext'
        ? { name: c.context ?? '', conclusion: c.state ?? null, status: 'COMPLETED' }
        : { name: c.name ?? '', conclusion: c.conclusion ?? null, status: c.status ?? null },
    );
    const reviews = ((raw.reviews as RawFeedback[] | null) ?? [])
      .filter((r) => (r.body ?? '').trim() !== '' || r.state !== 'COMMENTED')
      .map((r) => ({ id: r.id, author: r.author?.login ?? '', body: (r.body ?? '').trim() || (r.state ?? ''), at: r.submittedAt ?? '' }));
    const comments = ((raw.comments as RawFeedback[] | null) ?? []).map((c) => ({
      id: c.id, author: c.author?.login ?? '', body: c.body ?? '', at: c.createdAt ?? '',
    }));
    return {
      number: raw.number as number, url: raw.url as string, title: raw.title as string,
      state: raw.state as PrData['state'], headRefName: raw.headRefName as string, headRefOid: raw.headRefOid as string,
      baseRefName: raw.baseRefName as string, mergeable: raw.mergeable as PrData['mergeable'],
      mergeStateStatus: raw.mergeStateStatus as string, checks,
      feedback: [...reviews, ...comments].sort((a, b) => a.at.localeCompare(b.at)),
    };
  }

  async findPrForBranch(cwd: string, branch: string): Promise<PrRef | null> {
    const rows = JSON.parse(
      await this.run(['pr', 'list', '--head', branch, '--state', 'open', '--json', 'number,url', '--limit', '1'], { cwd }),
    ) as { number: number; url: string }[];
    const row = rows[0];
    const repo = row ? repoFromPrUrl(row.url) : null;
    return row && repo ? { repo, number: row.number, url: row.url } : null;
  }

  async listMyPrs() {
    const rows = JSON.parse(
      await this.run(['search', 'prs', '--author', '@me', '--state', 'open', '--json', 'number,url,title,headRefName,state', '--limit', '50']),
    ) as { number: number; url: string; title: string; headRefName: string; state: string }[];
    return rows.flatMap((r) => {
      const repo = repoFromPrUrl(r.url);
      return repo ? [{ ...r, repo }] : [];
    });
  }
}
```
(The `gh search prs --json` field list must include `headRefName`; if gh rejects it, drop it from the query and fill `headRefName: ''` — rule and ledger it.)
- [ ] **Step 3:** → PASS; typecheck. Commit `feat(engine): gh client for PR data`.

---

### Task 3: Snapshots and diffing

**Files:** Create `packages/engine/src/pr/snapshot.ts`; test `packages/engine/test/pr/snapshot.test.ts`.

**Interfaces — produces:**
```ts
export const BOT_LOGINS: readonly string[];
export interface PrSnapshot {
  state: PrData['state'];
  headRefOid: string;
  baseRefName: string;
  mergeable: PrData['mergeable'];
  mergeStateStatus: string;
  failingChecks: string[];      // names, sorted
  lastFeedbackAt: string;       // ISO of newest feedback seen ('' if none)
}
export function toSnapshot(pr: PrData): PrSnapshot;
export function diffSnapshots(prev: PrSnapshot, next: PrSnapshot, pr: PrData, viewer: string): PrEvent[];
```
Each `PrEvent.details` is the wake prompt text for the session (Task 6 sends it as is); `summary` is one line for the notification.

- [ ] **Step 1 (red):**
```ts
import { describe, expect, it } from 'vitest';
import type { PrData } from '../../src/pr/gh-client';
import { diffSnapshots, toSnapshot } from '../../src/pr/snapshot';

const pr = (over: Partial<PrData> = {}): PrData => ({
  number: 7, url: 'https://github.com/o/r/pull/7', title: 'Mileage', state: 'OPEN',
  headRefName: 'feat/m', headRefOid: 'h1', baseRefName: 'main', mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN',
  checks: [{ name: 'lint', conclusion: 'SUCCESS', status: 'COMPLETED' }], feedback: [], ...over,
});
const diff = (a: PrData, b: PrData, viewer = 'me') => diffSnapshots(toSnapshot(a), toSnapshot(b), b, viewer);
const kinds = (a: PrData, b: PrData, viewer?: string) => diff(a, b, viewer).map((e) => e.kind);
const failing = (...names: string[]) => names.map((name) => ({ name, conclusion: 'FAILURE', status: 'COMPLETED' }));

describe('diffSnapshots', () => {
  it('reports nothing when nothing changed', () => {
    expect(kinds(pr(), pr())).toEqual([]);
  });

  it('ci_failed once per newly failing check on the same head, not on every poll', () => {
    const a = pr();
    const b = pr({ checks: failing('test') });
    expect(kinds(a, b)).toEqual(['ci_failed']);
    expect(kinds(b, b)).toEqual([]);
    const c = pr({ checks: [...failing('test'), ...failing('e2e')] });
    const events = diff(b, c);
    expect(events.map((e) => e.kind)).toEqual(['ci_failed']);
    expect(events[0]!.details).toContain('e2e');
    expect(events[0]!.details).not.toMatch(/\btest\b.*\be2e\b/); // only the new failure is named as new
  });

  it('a new head commit resets failures, so failing again wakes again', () => {
    const failed = pr({ checks: failing('test') });
    const pushedGreen = pr({ headRefOid: 'h2', checks: [{ name: 'test', conclusion: null, status: 'IN_PROGRESS' }] });
    const failedAgain = pr({ headRefOid: 'h2', checks: failing('test') });
    expect(kinds(failed, pushedGreen)).toEqual([]);
    expect(kinds(pushedGreen, failedAgain)).toEqual(['ci_failed']);
  });

  it('counts TIMED_OUT, CANCELLED, ACTION_REQUIRED, STARTUP_FAILURE and status ERROR as failing', () => {
    for (const conclusion of ['TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'ERROR', 'FAILURE']) {
      expect(kinds(pr(), pr({ checks: [{ name: 'x', conclusion, status: 'COMPLETED' }] }))).toEqual(['ci_failed']);
    }
    expect(kinds(pr(), pr({ checks: [{ name: 'x', conclusion: 'SKIPPED', status: 'COMPLETED' }] }))).toEqual([]);
  });

  it('review_comment for new feedback from others, never from the viewer or bots', () => {
    const at = (m: number) => `2026-09-23T10:0${m}:00Z`;
    const base = pr({ feedback: [{ id: 'old', author: 'ana', body: 'old', at: at(0) }] });
    const mine = pr({ feedback: [...base.feedback, { id: 'm', author: 'me', body: 'I replied', at: at(1) }] });
    expect(kinds(base, mine)).toEqual([]);
    const bots = pr({
      feedback: [
        ...base.feedback,
        { id: 'b1', author: 'github-actions', body: 'coverage', at: at(2) },
        { id: 'b2', author: 'mergify[bot]', body: 'queued', at: at(3) },
      ],
    });
    expect(kinds(base, bots)).toEqual([]);
    const review = pr({ feedback: [...base.feedback, { id: 'r', author: 'bob', body: 'Please rename x', at: at(4) }] });
    const events = diff(base, review);
    expect(events.map((e) => e.kind)).toEqual(['review_comment']);
    expect(events[0]!.details).toContain('bob');
    expect(events[0]!.details).toContain('Please rename x');
  });

  it('base_moved only when the PR becomes conflicting or behind', () => {
    expect(kinds(pr(), pr({ mergeable: 'CONFLICTING' }))).toEqual(['base_moved']);
    expect(kinds(pr(), pr({ mergeStateStatus: 'BEHIND' }))).toEqual(['base_moved']);
    expect(kinds(pr({ mergeable: 'CONFLICTING' }), pr({ mergeable: 'CONFLICTING' }))).toEqual([]);
    expect(kinds(pr({ mergeable: 'UNKNOWN' }), pr({ mergeable: 'MERGEABLE' }))).toEqual([]);
  });

  it('merged when the state becomes MERGED; nothing else is reported with it', () => {
    expect(kinds(pr(), pr({ state: 'MERGED', checks: failing('late') }))).toEqual(['merged']);
  });
});
```
Run → FAIL.
- [ ] **Step 2:** Implementation:
```ts
import type { PrEvent } from '@relay/shared';
import type { PrData } from './gh-client';

/** GitHub does not flag every bot as one; these are ignored as review feedback. */
export const BOT_LOGINS: readonly string[] = [
  'github-actions', 'dependabot', 'codecov', 'renovate', 'vercel', 'netlify', 'sonarcloud', 'linear',
];
const FAILING = new Set(['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'ERROR']);
const BODY_MAX = 800;

export interface PrSnapshot { ... as above ... }

const clip = (t: string) => (t.length > BODY_MAX ? `${t.slice(0, BODY_MAX)}…` : t);
const isBot = (login: string) => login.endsWith('[bot]') || BOT_LOGINS.includes(login.toLowerCase());

export function toSnapshot(pr: PrData): PrSnapshot {
  return {
    state: pr.state,
    headRefOid: pr.headRefOid,
    baseRefName: pr.baseRefName,
    mergeable: pr.mergeable,
    mergeStateStatus: pr.mergeStateStatus,
    failingChecks: pr.checks.filter((c) => c.conclusion && FAILING.has(c.conclusion)).map((c) => c.name).sort(),
    lastFeedbackAt: pr.feedback.reduce((max, f) => (f.at > max ? f.at : max), ''),
  };
}

/** Events between two polls of one PR; `pr` is the newer data, used for event details. */
export function diffSnapshots(prev: PrSnapshot, next: PrSnapshot, pr: PrData, viewer: string): PrEvent[] {
  const ref = `PR #${pr.number} (${pr.url})`;
  if (next.state === 'MERGED' && prev.state !== 'MERGED') {
    return [{ kind: 'merged', summary: `PR #${pr.number} merged`, details: `${ref} was merged.` }];
  }
  const events: PrEvent[] = [];

  const before = prev.headRefOid === next.headRefOid ? new Set(prev.failingChecks) : new Set<string>();
  const newlyFailing = next.failingChecks.filter((n) => !before.has(n));
  if (newlyFailing.length > 0) {
    events.push({
      kind: 'ci_failed',
      summary: `CI failed on PR #${pr.number}: ${newlyFailing.join(', ')}`,
      details:
        `CI failed on ${ref}. Newly failing checks: ${newlyFailing.join(', ')}. ` +
        `Look at the failures (for example \`gh pr checks ${pr.number}\` and \`gh run view --log-failed\`), fix them, run the tests, and push.`,
    });
  }

  const fresh = pr.feedback.filter((f) => f.at > prev.lastFeedbackAt && f.author !== viewer && !isBot(f.author));
  if (fresh.length > 0) {
    const lines = fresh.map((f) => `- ${f.author}: ${clip(f.body)}`).join('\n');
    events.push({
      kind: 'review_comment',
      summary: `New feedback on PR #${pr.number} from ${[...new Set(fresh.map((f) => f.author))].join(', ')}`,
      details: `New review feedback on ${ref}:\n${lines}\nAddress it in the code, run the tests, and push. Reply on the PR only if a change is not warranted.`,
    });
  }

  const blocked = (s: PrSnapshot) => s.mergeable === 'CONFLICTING' || s.mergeStateStatus === 'BEHIND';
  if (blocked(next) && !blocked(prev)) {
    const why = next.mergeable === 'CONFLICTING' ? 'now has conflicts with' : 'is now behind';
    events.push({
      kind: 'base_moved',
      summary: `PR #${pr.number} ${why} ${pr.baseRefName}`,
      details: `${ref} ${why} its base branch ${pr.baseRefName}. Fetch, rebase onto origin/${pr.baseRefName}, resolve any conflicts, run the tests, and push.`,
    });
  }
  return events;
}
```
The test "only the new failure is named as new" checks that `details` lists `e2e` but not `test` in the "Newly failing" list — the regex asserts `test` does not appear before `e2e` in it; if that regex proves brittle against the wording, assert `events[0]!.summary` equals `'CI failed on PR #7: e2e'` instead and record the change as a ruling.
- [ ] **Step 3:** → PASS; typecheck. Commit `feat(engine): PR snapshots and event diffing`.

---

### Task 4: Store — watches

**Files:** Modify `packages/engine/src/store/session-store.ts`; test `packages/engine/test/store/session-store.test.ts`.

**Interfaces — produces:** `saveWatch(watch: PrWatch, snapshot: PrSnapshot | null): void`, `loadWatches(): { watch: PrWatch; snapshot: PrSnapshot | null }[]` (oldest first), `deleteWatch(id: string): void`.

- [ ] **Step 1 (red):**
```ts
  it('saves, updates, loads and deletes PR watches with their snapshot', () => {
    const store = new SessionStore(':memory:');
    const w: PrWatch = {
      id: 'w1', sessionId: 's1', repo: 'o/r', prNumber: 7, prUrl: 'u', active: true,
      createdAt: '2026-09-23T10:00:00.000Z', lastPolledAt: null, lastError: null,
    };
    store.saveWatch(w, null);
    store.saveWatch({ ...w, lastPolledAt: '2026-09-23T10:05:00.000Z' }, {
      state: 'OPEN', headRefOid: 'h', baseRefName: 'main', mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN',
      failingChecks: [], lastFeedbackAt: '',
    });
    const [loaded] = store.loadWatches();
    expect(loaded!.watch.lastPolledAt).toBe('2026-09-23T10:05:00.000Z');
    expect(loaded!.snapshot?.headRefOid).toBe('h');
    store.deleteWatch('w1');
    expect(store.loadWatches()).toEqual([]);
  });
```
(import `PrWatch` from `@relay/shared`, `PrSnapshot` type from `../../src/pr/snapshot`.) Run → FAIL.
- [ ] **Step 2:** table `pr_watches (id text primary key, created_at text not null, watch text not null, snapshot text)`; `saveWatch` upserts both JSON columns (snapshot `null` stores SQL null); `loadWatches` orders by `created_at`; `deleteWatch` deletes by id.
- [ ] **Step 3:** → PASS. Commit `feat(engine): persist PR watches`.

---

### Task 5: PrWatcher

**Files:** Create `packages/engine/src/pr/pr-watcher.ts`; test `packages/engine/test/pr/pr-watcher.test.ts`.

**Interfaces:**
- Consumes: `GhClient`, `PrData` (Task 2); `toSnapshot`, `diffSnapshots`, `PrSnapshot` (Task 3); Store watch methods (Task 4).
- Produces:
  ```ts
  export const PR_POLL_INTERVAL_MS = 300_000;
  export interface PrWatcherOptions { gh: GhClient; store: SessionStore; intervalMs?: number; now?: () => Date }
  class PrWatcher extends EventEmitter<{
    watch: [PrWatch];                      // any change to a watch
    event: [PrWatch, PrEvent];             // one per event
    gh: [GhStatus];                        // on status change only
  }> {
    constructor(opts: PrWatcherOptions)    // loads persisted watches
    add(ref: { sessionId: string; repo: string; prNumber: number; prUrl: string }): Promise<PrWatch>  // polls once for the baseline
    remove(watchId: string): void          // deletes it
    list(): PrWatch[]
    forSession(sessionId: string): PrWatch | null   // the active one
    get ghStatus(): GhStatus
    pollAll(): Promise<void>               // one pass over active watches, sequential
    start(): void                          // interval timer (unref'd)
    stop(): void
  }
  ```
  Rules: `add` rejects when the session already has an active watch; the baseline poll failing still creates the watch (with `lastError`), so the next poll baselines it. Poll with no stored snapshot → store the baseline, no events. `merged` or `CLOSED` → watch `active: false` (still listed; `pollAll` skips it). The viewer login is fetched once (lazily) and cached; a failure there counts as a gh failure. `pollAll` never runs twice at once (a pass in progress makes a second call return the same promise).

- [ ] **Step 1 (red):**
```ts
import { describe, expect, it } from 'vitest';
import type { GhStatus, PrEvent, PrWatch } from '@relay/shared';
import type { GhClient, PrData } from '../../src/pr/gh-client';
import { PrWatcher } from '../../src/pr/pr-watcher';
import { SessionStore } from '../../src/store/session-store';

const pr = (over: Partial<PrData> = {}): PrData => ({
  number: 7, url: 'https://github.com/o/r/pull/7', title: 'M', state: 'OPEN', headRefName: 'feat/m', headRefOid: 'h1',
  baseRefName: 'main', mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', checks: [], feedback: [], ...over,
});

class FakeGh implements GhClient {
  data: PrData = pr();
  fail: string | null = null;
  views = 0;
  async viewer() { if (this.fail) throw new Error(this.fail); return 'me'; }
  async viewPr() { this.views += 1; if (this.fail) throw new Error(this.fail); return this.data; }
  async findPrForBranch() { return null; }
  async listMyPrs() { return []; }
}

function setup(store = new SessionStore(':memory:')) {
  const gh = new FakeGh();
  const w = new PrWatcher({ gh, store, now: () => new Date('2026-09-23T12:00:00.000Z') });
  const events: [PrWatch, PrEvent][] = [];
  const statuses: GhStatus[] = [];
  w.on('event', (watch, e) => events.push([watch, e]));
  w.on('gh', (s) => statuses.push(s));
  return { gh, w, events, statuses, store };
}
const ref = { sessionId: 's1', repo: 'o/r', prNumber: 7, prUrl: 'https://github.com/o/r/pull/7' };
const failing = [{ name: 'test', conclusion: 'FAILURE', status: 'COMPLETED' }];

describe('PrWatcher', () => {
  it('add baselines without events; a later change produces one event per poll change', async () => {
    const { gh, w, events } = setup();
    const watch = await w.add(ref);
    expect(watch).toMatchObject({ sessionId: 's1', active: true, lastPolledAt: '2026-09-23T12:00:00.000Z', lastError: null });
    expect(events).toEqual([]);
    gh.data = pr({ checks: failing });
    await w.pollAll();
    await w.pollAll();
    expect(events.map(([, e]) => e.kind)).toEqual(['ci_failed']);
  });

  it('refuses a second active watch for the same session', async () => {
    const { w } = setup();
    await w.add(ref);
    await expect(w.add(ref)).rejects.toThrow(/already watching/i);
  });

  it('a failed poll records the error, reports gh unavailable, keeps the snapshot and produces no events', async () => {
    const { gh, w, events, statuses } = setup();
    await w.add(ref);
    gh.fail = 'gh: not logged in';
    gh.data = pr({ checks: failing });
    await w.pollAll();
    expect(w.list()[0]!.lastError).toBe('gh: not logged in');
    expect(w.ghStatus).toEqual({ state: 'unavailable', message: 'gh: not logged in' });
    expect(events).toEqual([]);
    gh.fail = null;
    await w.pollAll();
    expect(w.ghStatus).toEqual({ state: 'ok' });
    expect(events.map(([, e]) => e.kind)).toEqual(['ci_failed']); // diffed against the kept pre-failure snapshot
    expect(statuses).toEqual([{ state: 'unavailable', message: 'gh: not logged in' }, { state: 'ok' }]);
  });

  it('a merged PR emits merged once and deactivates the watch', async () => {
    const { gh, w, events } = setup();
    await w.add(ref);
    gh.data = pr({ state: 'MERGED' });
    await w.pollAll();
    await w.pollAll();
    expect(events.map(([, e]) => e.kind)).toEqual(['merged']);
    expect(w.list()[0]!.active).toBe(false);
    expect(w.forSession('s1')).toBeNull();
  });

  it('a closed-not-merged PR deactivates the watch without an event', async () => {
    const { gh, w, events } = setup();
    await w.add(ref);
    gh.data = pr({ state: 'CLOSED' });
    await w.pollAll();
    expect(events).toEqual([]);
    expect(w.list()[0]!.active).toBe(false);
  });

  it('persists watches and snapshots across restarts', async () => {
    const store = new SessionStore(':memory:');
    const first = setup(store);
    await first.w.add(ref);
    const second = setup(store);
    expect(second.w.list().map((x) => x.sessionId)).toEqual(['s1']);
    second.gh.data = pr({ checks: failing });
    await second.w.pollAll();
    expect(second.events.map(([, e]) => e.kind)).toEqual(['ci_failed']); // no second baseline
  });

  it('remove deletes the watch', async () => {
    const { w, store } = setup();
    const watch = await w.add(ref);
    w.remove(watch.id);
    expect(w.list()).toEqual([]);
    expect(store.loadWatches()).toEqual([]);
  });

  it('overlapping pollAll calls share one pass', async () => {
    const { gh, w } = setup();
    await w.add(ref);
    gh.views = 0;
    await Promise.all([w.pollAll(), w.pollAll()]);
    expect(gh.views).toBe(1);
  });
});
```
Run → FAIL.
- [ ] **Step 2:** Implementation (`pr-watcher.ts`):
```ts
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { GhStatus, PrEvent, PrWatch } from '@relay/shared';
import type { SessionStore } from '../store/session-store';
import type { GhClient } from './gh-client';
import { diffSnapshots, toSnapshot, type PrSnapshot } from './snapshot';

export const PR_POLL_INTERVAL_MS = 300_000;

export interface PrWatcherOptions { gh: GhClient; store: SessionStore; intervalMs?: number; now?: () => Date }

type WatcherEvents = { watch: [PrWatch]; event: [PrWatch, PrEvent]; gh: [GhStatus] };
type Entry = { watch: PrWatch; snapshot: PrSnapshot | null };

/** Polls `gh` for each watched PR, diffs against the last snapshot, and emits what changed. */
export class PrWatcher extends EventEmitter<WatcherEvents> {
  private readonly entries = new Map<string, Entry>();
  private readonly gh: GhClient;
  private readonly store: SessionStore;
  private readonly intervalMs: number;
  private readonly now: () => Date;
  private viewer: string | null = null;
  private status: GhStatus = { state: 'ok' };
  private timer: NodeJS.Timeout | null = null;
  private pass: Promise<void> | null = null;

  constructor(opts: PrWatcherOptions) {
    super();
    this.gh = opts.gh;
    this.store = opts.store;
    this.intervalMs = opts.intervalMs ?? PR_POLL_INTERVAL_MS;
    this.now = opts.now ?? (() => new Date());
    for (const e of opts.store.loadWatches()) this.entries.set(e.watch.id, { watch: e.watch, snapshot: e.snapshot });
  }

  get ghStatus(): GhStatus { return this.status; }

  list(): PrWatch[] { return [...this.entries.values()].map((e) => ({ ...e.watch })); }

  forSession(sessionId: string): PrWatch | null {
    const e = [...this.entries.values()].find((x) => x.watch.sessionId === sessionId && x.watch.active);
    return e ? { ...e.watch } : null;
  }

  async add(ref: { sessionId: string; repo: string; prNumber: number; prUrl: string }): Promise<PrWatch> {
    if (this.forSession(ref.sessionId)) throw new Error(`Already watching a PR for session ${ref.sessionId}`);
    const entry: Entry = {
      watch: { id: randomUUID(), ...ref, active: true, createdAt: this.now().toISOString(), lastPolledAt: null, lastError: null },
      snapshot: null,
    };
    this.entries.set(entry.watch.id, entry);
    await this.poll(entry);
    return { ...entry.watch };
  }

  remove(watchId: string): void {
    this.entries.delete(watchId);
    this.store.deleteWatch(watchId);
  }

  pollAll(): Promise<void> {
    this.pass ??= (async () => {
      try {
        for (const e of this.entries.values()) if (e.watch.active) await this.poll(e);
      } finally {
        this.pass = null;
      }
    })();
    return this.pass;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.pollAll(), this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async poll(entry: Entry): Promise<void> {
    const w = entry.watch;
    try {
      this.viewer ??= await this.gh.viewer();
      const pr = await this.gh.viewPr(w.repo, w.prNumber);
      const next = toSnapshot(pr);
      const events = entry.snapshot ? diffSnapshots(entry.snapshot, next, pr, this.viewer) : [];
      entry.snapshot = next;
      w.lastPolledAt = this.now().toISOString();
      w.lastError = null;
      if (pr.state !== 'OPEN') w.active = false;
      this.setStatus({ state: 'ok' });
      this.save(entry);
      for (const e of events) this.emit('event', { ...w }, e);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      w.lastError = message;
      this.setStatus({ state: 'unavailable', message });
      this.save(entry);
    }
  }

  private save(entry: Entry): void {
    this.store.saveWatch(entry.watch, entry.snapshot);
    this.emit('watch', { ...entry.watch });
  }

  private setStatus(next: GhStatus): void {
    const same = next.state === this.status.state && (next.state === 'ok' || (this.status.state === 'unavailable' && this.status.message === next.message));
    this.status = next;
    if (!same) this.emit('gh', next);
  }
}
```
- [ ] **Step 3:** → PASS; typecheck. Commit `feat(engine): PR watcher — poll, diff, persist, gh status`.

---

### Task 6: Engine integration

**Files:** Modify `packages/engine/src/relay-engine.ts`, `packages/engine/src/orchestrator/relay-tools.ts`, `packages/engine/src/orchestrator/system-prompt.ts`, `packages/engine/src/index.ts`; tests `packages/engine/test/relay-engine.test.ts`, `packages/engine/test/orchestrator/relay-tools.test.ts`.

**Interfaces:**
- Produces:
  ```ts
  RelayEngineOptions += { gh?: GhClient; prPollIntervalMs?: number }
  RelayEngine.watchCreate(sessionId: string): Promise<PrWatch>   // resolves the PR, refuses if none
  RelayEngine.watchDelete(watchId: string): void
  RelayEngine.activeSessions(): { id: string; title: string; state: SessionState }[]   // running or waiting-approval, for the quit dialog
  runState().watches / runState().gh
  RelayToolDeps += { listPrs(): Promise<...>; createWatch(sessionId: string): Promise<PrWatch>; deleteWatch(sessionId: string): Promise<void> }
  tools 'list_prs' {}, 'create_watch' { id: string }, 'delete_watch' { id: string }   (id = session id)
  ```
  Behaviour:
  - `watchCreate`: session from `listSessions()` (else `Unknown session`). PR ref: `session.prUrl` + `session.prNumber` when both exist and `repoFromPrUrl` works; else `gh.findPrForBranch(session.cwd, session.branch)` when the session has a branch and `cwdExists`; else throw `No pull request found for session "<title>" (branch <branch or none>)`.
  - Watcher events → `publish({ type: 'pr-event', sessionId, watchId, event })`; then, unless `event.kind === 'merged'` or `closing`, `this.send({ sessionId, prompt: event.details, mode: 'queue', origin: \`watch:${event.kind}\` }).catch((err) => record err.message as the watch's lastError via a watcher method)`. Add `PrWatcher.noteError(watchId, message)` for that (saves and emits `watch`).
  - Watcher `watch` → `publish({ type: 'watch', watch, gh: watcher.ghStatus })` — every poll saves the watch, so the renderer always has the current `gh` status with it.
  - `start()` creates the watcher (`opts.gh ?? new ExecGhClient()`), then `watcher.start()`; `close()` calls `watcher.stop()` first.
  - `list_prs` returns `gh.listMyPrs()` joined to sessions by `headRefName === session.branch` → `{ repo, number, url, title, branch, sessionId | null, watched: boolean }`.
  - `delete_watch` by session id: the active watch for that session, else a tool error `Not watching a PR for that session`.
  - System prompt: tool list line gains `list_prs, create_watch and delete_watch`; add `- To keep an eye on a session's pull request, use create_watch; Relay polls it and wakes the session on CI failures, review comments or conflicts. You are not told about those wakes.`

- [ ] **Step 1 (red) — tools:** `relay-tools.test.ts` `deps()` adds `listPrs: vi.fn(async () => [{ repo: 'o/r', number: 7, url: 'u', title: 'M', branch: 'feat/mileage', sessionId: 'a', watched: false }])`, `createWatch: vi.fn(async (id: string) => ({ id: 'w1', sessionId: id, repo: 'o/r', prNumber: 7, prUrl: 'u', active: true, createdAt: 'x', lastPolledAt: 'x', lastError: null }))`, `deleteWatch: vi.fn(async () => undefined)`; the "exposes exactly" list ends with `'list_prs', 'create_watch', 'delete_watch'`; add:
```ts
  it('list_prs, create_watch and delete_watch call through and report errors as tool errors', async () => {
    const d = deps();
    expect(JSON.parse((await call(d, 'list_prs', {})).text)).toEqual([
      { repo: 'o/r', number: 7, url: 'u', title: 'M', branch: 'feat/mileage', sessionId: 'a', watched: false },
    ]);
    expect(JSON.parse((await call(d, 'create_watch', { id: 'a' })).text)).toMatchObject({ watching: true, prNumber: 7 });
    expect(d.createWatch).toHaveBeenCalledWith('a');
    expect(JSON.parse((await call(d, 'delete_watch', { id: 'a' })).text)).toEqual({ watching: false });
    const bad = deps({ createWatch: async () => { throw new Error('No pull request found for session "A" (branch none)'); } });
    expect(await call(bad, 'create_watch', { id: 'a' })).toEqual({ text: 'No pull request found for session "A" (branch none)', isError: true });
  });
```
- [ ] **Step 2 (red) — engine:** in `relay-engine.test.ts` add a `FakeGh` (same shape as Task 5's, with `found: PrRef | null` for `findPrForBranch` and `mine` for `listMyPrs`) and pass `gh` through `startWithBasic` extra (`gh?: GhClient`). Note `basic.jsonl` has a `pr-link` (#42, `https://github.com/org/repo/pull/42`).
```ts
  it('watching a session\'s PR wakes it with a queued watch message when CI fails, and never the orchestrator', async () => {
    const { orchClient, perSession, router } = perSessionRouter();
    const gh = new FakeGh();
    await startWithBasic(router, undefined, { gh });
    const watch = await engine!.watchCreate('s-basic');
    expect(watch).toMatchObject({ repo: 'org/repo', prNumber: 42, active: true });
    const events: RunnerEvent[] = [];
    engine!.onEvent((e) => events.push(e));
    gh.data = { ...gh.data, checks: [{ name: 'test', conclusion: 'FAILURE', status: 'COMPLETED' }] };
    await engine!['watcher'].pollAll();
    await tick();
    expect(events.find((e) => e.type === 'pr-event')).toMatchObject({ sessionId: 's-basic', event: { kind: 'ci_failed' } });
    const woke = perSession.get('s-basic')!.received;
    expect(woke).toHaveLength(1);
    expect(woke[0]).toMatchObject({ priority: 'next', origin: 'watch:ci_failed' });
    expect(woke[0]!.text).toContain('Newly failing checks: test');
    perSession.get('s-basic')!.result();
    await tick();
    expect(orchClient.received.filter((m) => m.origin.startsWith('watch:'))).toHaveLength(0);
  });

  it('falls back to gh for a session without a recorded PR, and says so when there is none', async () => {
    const gh = new FakeGh();
    await startWithBasic(new FakeAgentClient(), undefined, { gh, noPr: true });
    await expect(engine!.watchCreate('nope')).rejects.toThrow(/unknown session/i);
    gh.found = { repo: 'o/r', number: 5, url: 'https://github.com/o/r/pull/5' };
    expect(await engine!.watchCreate('s-nopr')).toMatchObject({ repo: 'o/r', prNumber: 5 });
    engine!.watchDelete(engine!.runState().watches[0]!.id);
    gh.found = null;
    await expect(engine!.watchCreate('s-nopr')).rejects.toThrow(/No pull request found for session/);
  });

  it('a wake refused because the session is busy elsewhere is recorded on the watch', async () => {
    const gh = new FakeGh();
    await startWithBasic(new FakeAgentClient(), undefined, {
      gh, registry: { foreignHolders: async () => [99] },
    });
    await engine!.watchCreate('s-basic');
    gh.data = { ...gh.data, checks: [{ name: 'test', conclusion: 'FAILURE', status: 'COMPLETED' }] };
    await engine!['watcher'].pollAll();
    await tick();
    expect(engine!.runState().watches[0]!.lastError).toMatch(/open in another Claude process/);
  });

  it('activeSessions lists running sessions for the quit dialog', async () => {
    const client = new FakeAgentClient();
    await startWithBasic(client);
    expect(engine!.activeSessions()).toEqual([]);
    await engine!.send({ sessionId: 's-basic', prompt: 'x', mode: 'steer', origin: 'user' });
    await tick();
    expect(engine!.activeSessions()).toEqual([{ id: 's-basic', title: 'Add tests for the zero-rate case', state: 'running' }]);
  });
```
  `startWithBasic` gains `extra.noPr?: boolean`: it also writes `projects/p/s-nopr.jsonl` from `basic.jsonl` with the `pr-link` line removed, `s-basic`→`s-nopr`, cwd an existing `wt-c`, mtime old. Run → FAIL.
- [ ] **Step 3:** Implementation as described in the Interfaces block. Keep `refuseRelayOnly()` on `createWatch` too (a relay-started turn must not start watches). Export `ExecGhClient`, `PrWatcher`, `PR_POLL_INTERVAL_MS`, `toSnapshot`, `diffSnapshots`, `repoFromPrUrl` and the types from `index.ts`.
- [ ] **Step 4:** `pnpm --filter @relay/engine test && pnpm typecheck` → green. Commit `feat(engine): PR watches in the engine — wake sessions, orchestrator tools`.

---

### Task 7: Desktop — IPC, notifications, quit confirmation, watch control, gh banner

**Files:** Modify `apps/desktop/src/ipc.ts`, `apps/desktop/src/main.ts`, `apps/desktop/src/ui/useRunState.ts`, `apps/desktop/src/ui/SessionPanel.tsx`, `apps/desktop/src/ui/App.tsx`, `apps/desktop/src/ui/styles.css`; tests `apps/desktop/src/ui/SessionPanel.test.tsx`, `apps/desktop/src/ui/App.test.tsx`.

- [ ] **Step 1 (red):** `SessionPanel.test.tsx`: add props `watch={null | PrWatch}`, `onWatch`, `onUnwatch` to `base` (null, `vi.fn()`, `vi.fn()`), and:
```tsx
  it('offers Watch PR for a session with a PR, and shows the watch once active', async () => {
    const onWatch = vi.fn();
    const withPr = { ...session, prNumber: 42, prUrl: 'https://github.com/o/r/pull/42' };
    const { rerender } = render(
      <SessionPanel {...base} session={withPr} onWatch={onWatch} entries={[]} liveEntries={[]} state={undefined} approvals={[]} />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Watch PR' }));
    expect(onWatch).toHaveBeenCalled();
    const onUnwatch = vi.fn();
    rerender(
      <SessionPanel {...base} session={withPr} onUnwatch={onUnwatch} entries={[]} liveEntries={[]} state={undefined} approvals={[]}
        watch={{ id: 'w1', sessionId: 'a', repo: 'o/r', prNumber: 42, prUrl: 'u', active: true, createdAt: 'x', lastPolledAt: '2026-09-23T12:00:00.000Z', lastError: 'gh: offline' }} />,
    );
    expect(screen.getByText(/Watching PR #42/)).toBeInTheDocument();
    expect(screen.getByText('gh: offline')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Stop watching' }));
    expect(onUnwatch).toHaveBeenCalledWith('w1');
  });
```
  (Sessions without a PR still show **Watch PR** — the engine resolves the branch's PR via gh or reports that there is none.)
  `App.test.tsx`: a `watch` runner event with `gh: { state: 'unavailable', message: 'gh: not logged in' }` shows a banner `role="alert"` containing that message; `Watch PR` in the panel calls `watchCreate('a')`; a failing `watchCreate` shows its message in the panel's error line.
  Run → FAIL.
- [ ] **Step 2:** Implementation.
  - `ipc.ts`: `handle(IPC.watchCreate, (sessionId: string) => engine.watchCreate(sessionId))`, `handle(IPC.watchDelete, (watchId: string) => engine.watchDelete(watchId))`; add to `channels`.
  - `useRunState`: `RunView` gains `watches: PrWatch[]` and `gh: GhStatus` (snapshot from `runState()`); `case 'watch'` replaces the watch by id (or appends) and sets `gh`; `case 'pr-event'` returns `v` (notifications are main-process).
  - `SessionPanel`: new props; in the header after the PR link: when `watch?.active` → `<span className="watch">Watching PR #{watch.prNumber}{watch.lastPolledAt ? ` · checked ${new Date(watch.lastPolledAt).toLocaleTimeString()}` : ''}</span> <button onClick={() => onUnwatch(watch.id)}>Stop watching</button>` plus `{watch.lastError && <span className="error">{watch.lastError}</span>}`; else `<button onClick={onWatch}>Watch PR</button>`.
  - `App`: pass `watch={run.watches.find((w) => w.sessionId === selected.id && w.active) ?? null}`, `onWatch={() => void window.relay.watchCreate(selected.id).catch((e: unknown) => setSendError(e instanceof Error ? e.message : String(e)))}`, `onUnwatch={(id) => void window.relay.watchDelete(id)}`; render `{run.gh.state === 'unavailable' && <div role="alert" className="gh-banner">GitHub CLI unavailable — PR watches paused: {run.gh.message}</div>}` at the top of `.app` (grid: make it span all columns: `grid-column: 1 / -1`).
  - `main.ts`:
    - notifications: `pr-event` → `new Notification({ title: 'Relay Hub: ' + event.event.summary, body: sessionTitle }).show()` where the title comes from `engine.listSessions()`.
    - quit confirmation in `before-quit`: before `event.preventDefault()`-and-close, `const active = engine.activeSessions(); if (active.length > 0) { const { response } = await dialog.showMessageBox({ type: 'warning', buttons: ['Quit', 'Cancel'], defaultId: 1, cancelId: 1, message: 'Sessions are still running', detail: active.map((s) => `• ${s.title} (${s.state})`).join('\n') + '\n\nQuitting interrupts them.' }); if (response === 1) { quitting = false; return; } }` — restructure the handler into an async function that sets `quitting` only once the user chose Quit.
  - Styles: `.gh-banner { grid-column: 1 / -1; background: #d98a00; color: #000; padding: 4px 12px; font-size: 12px; } .watch { font-size: 11px; opacity: .8; }`, and `.app { grid-template-rows: auto 1fr; }` only when the banner shows — simpler: render the banner as a fixed-position strip (`position: fixed; top: 0; left: 0; right: 0; z-index: 10;`) so the grid is untouched.
- [ ] **Step 3:** `pnpm --filter @relay/desktop test && pnpm typecheck && pnpm --filter @relay/desktop test:e2e` → green. Commit `feat(desktop): watch PRs from the session panel, gh banner, notifications, quit confirmation`.

---

### Task 8: Live gh check, README

**Files:** Create `packages/engine/test/live/gh-live.test.ts`; modify `README.md`.

- [ ] **Step 1:** A read-only live test (no tokens, just `gh`), gated on `RELAY_LIVE_GH=<owner/repo#number>`:
```ts
import { describe, expect, it } from 'vitest';
import { ExecGhClient } from '../../src/pr/gh-client';
import { diffSnapshots, toSnapshot } from '../../src/pr/snapshot';

const target = process.env.RELAY_LIVE_GH; // e.g. factorialco/factorial-agent#3299

describe.skipIf(!target)('gh client against GitHub', () => {
  it('reads a real PR, snapshots it and diffs it against itself without events', async () => {
    const [repo, num] = target!.split('#');
    const gh = new ExecGhClient();
    const viewer = await gh.viewer();
    const pr = await gh.viewPr(repo!, Number(num));
    expect(pr.number).toBe(Number(num));
    expect(pr.url).toContain(`/pull/${num}`);
    const snap = toSnapshot(pr);
    expect(diffSnapshots(snap, snap, pr, viewer)).toEqual([]);
    expect((await gh.listMyPrs()).every((p) => p.repo.includes('/'))).toBe(true);
  }, 60_000);
});
```
  Run `RELAY_LIVE_GH=factorialco/factorial-agent#3299 pnpm --filter @relay/engine test gh-live` → PASS.
- [ ] **Step 2:** README "PR watches (M5)": **Watch PR** in a session's panel (or ask Relay); every 5 minutes Relay asks `gh` about it and wakes the session when CI fails, someone reviews, or the PR falls behind or into conflict; merged PRs stop being watched; needs `gh auth login`.
- [ ] **Step 3:** Commit `docs: PR watches; live gh check`.

---

## Follow-ups

- Cloud sessions and a daemon (spec "Out of scope for v1").
- Watch events as bulk-action input ("rebase every watched PR that is behind").
