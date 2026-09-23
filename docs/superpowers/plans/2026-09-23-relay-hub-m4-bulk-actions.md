# Relay Hub — Milestone 4: Bulk actions

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The orchestrator can propose one instruction for many sessions as a plan card in the chat; nothing runs until the user confirms (with rows unticked as they like), then the rows run with a concurrency cap, show per-row progress, and the orchestrator gets one summary at the end.

**Architecture:** A new engine module `bulk/` owns bulk runs: `BulkRuns` keeps each run's rows, dispatches confirmed rows through `RelayEngine.send` with origin `bulk:<runId>` (at most 3 at a time), and moves rows on as session runners report `turn-end`. `RelayEngine` exposes the orchestrator tool `propose_bulk_action`, publishes a `bulk` runner event on every change, persists runs in the Store, and relays one `[bulk-end]` summary to the orchestrator. The chat renders each run as a `BulkRunCard`, interleaved with the conversation by time.

**Tech Stack:** as M3.

**Spec:** `docs/superpowers/specs/2026-09-23-relay-hub-design.md` — "Bulk action", "Orchestrator tools" (`propose_bulk_action`), "UI" (plan cards, bulk-run cards).

## Global Constraints

- Nothing in a bulk run is sent before the user confirms it in the UI. The orchestrator cannot confirm (no tool for it).
- Concurrency cap: 3 rows running at once (`BULK_CONCURRENCY = 3`), constructor-injectable for tests.
- Row statuses: `proposed` → (`skipped` | `queued`) → `running` → (`done` | `error`); a row whose send is refused (busy, unknown) goes straight to `error` with the refusal as its message. Run statuses: `proposed` → (`cancelled` | `running`) → `finished`.
- Bulk sends use origin `` `bulk:${runId}` ``; the per-session completion relay (M3) ignores them — only one `[bulk-end]` summary per run reaches the orchestrator, with mode `queue` and origin `watch:bulk-end`.
- The M3 guard applies: a turn started only by a relay cannot call `propose_bulk_action` either.
- Runs are persisted (Store table `bulk_runs`, JSON). On engine start, loaded runs still `running` are marked `finished` with their unfinished rows `error: 'Relay was closed during the run'`; `proposed` runs become `cancelled`. `runState().bulkRuns` returns the 20 most recent.
- The system-prompt line "Send to one session per request…" is replaced by: more than one target always goes through `propose_bulk_action`.
- Commits end with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`. No ticket ids in code.

## Review Focus

1. **A session in the plan becomes busy or disappears before confirm.** Its row must end `error` with the reason while the other rows run (Task 3).
2. **Unticking every row.** Confirm with an empty selection must behave like cancel, not start a run that never finishes (Task 3).
3. **A row that steers a session already running from elsewhere in Relay.** The bulk row's turn-end is recognised by its `bulk:<id>` origin even when the same turn also settles another send (Task 3).
4. **Double confirm / confirm after cancel / confirm of an unknown run** from a double-click or a stale card: must throw a clear error and change nothing (Task 3).
5. **App quit mid-run and restart.** The card must not claim rows are still running forever (Task 2, Task 4).

---

### Task 1: Shared contract

**Files:** Modify `packages/shared/src/runner.ts`, `packages/shared/src/ipc.ts`, `packages/shared/src/index.ts`; `apps/desktop/src/preload.ts`, `apps/desktop/src/ui/App.test.tsx` (stubs).

**Interfaces — produces:**
```ts
export type MessageOrigin = 'user' | 'orchestrator' | `watch:${string}` | `bulk:${string}`;

export type BulkRowStatus = 'proposed' | 'skipped' | 'queued' | 'running' | 'done' | 'error';
export interface BulkRow {
  sessionId: string;
  title: string;
  branch: string | null;
  prompt: string;
  status: BulkRowStatus;
  /** Last reply on done, the reason on error. */
  detail: string | null;
}
export type BulkRunStatus = 'proposed' | 'cancelled' | 'running' | 'finished';
export interface BulkRun {
  id: string;
  createdAt: string;
  mode: DeliveryMode;
  status: BulkRunStatus;
  rows: BulkRow[];
}
RunnerEvent += { type: 'bulk'; run: BulkRun }
RunState += { bulkRuns: BulkRun[] }
IPC.bulkConfirm = 'relay:bulkConfirm', IPC.bulkCancel = 'relay:bulkCancel'
RelayApi.bulkConfirm(runId: string, sessionIds: string[]): Promise<void>
RelayApi.bulkCancel(runId: string): Promise<void>
```

- [ ] **Step 1:** Add the types above to `runner.ts` (`BulkRun` etc. after `ApprovalDecision`; extend `MessageOrigin`, `RunnerEvent`, `RunState`), export them from `index.ts`, add channels + `RelayApi` members in `ipc.ts`.
- [ ] **Step 2 (red):** `pnpm typecheck` → FAIL in `preload.ts`, `App.test.tsx`, and engine `relay-engine.ts` (`runState()` lacks `bulkRuns`).
- [ ] **Step 3:** `preload.ts`: `bulkConfirm: (runId, sessionIds) => ipcRenderer.invoke(IPC.bulkConfirm, runId, sessionIds)`, `bulkCancel: (runId) => ipcRenderer.invoke(IPC.bulkCancel, runId)`. `App.test.tsx` fake: `bulkConfirm: vi.fn().mockResolvedValue(undefined), bulkCancel: vi.fn().mockResolvedValue(undefined)`, and `runState` resolves `{ states: {}, approvals: [], bulkRuns: [] }`. In `relay-engine.ts` `runState()` return `bulkRuns: []` for now (Task 4 fills it). Also `useRunState` in the desktop must keep compiling: it spreads `s.states`/`s.approvals` only, fine.
- [ ] **Step 4:** `pnpm typecheck && pnpm test` → green. Commit `feat(shared): bulk run contract`.

---

### Task 2: Store — bulk run persistence

**Files:** Modify `packages/engine/src/store/session-store.ts`; test `packages/engine/test/store/session-store.test.ts`.

**Interfaces — produces:** `SessionStore.saveBulkRun(run: BulkRun): void`, `SessionStore.loadBulkRuns(limit: number): BulkRun[]` (newest `createdAt` first).

- [ ] **Step 1 (red):**
```ts
  it('saves bulk runs by id and loads the newest first', () => {
    const store = new SessionStore(':memory:');
    const run = (id: string, createdAt: string, status: BulkRun['status'] = 'proposed'): BulkRun => ({
      id, createdAt, mode: 'steer', status,
      rows: [{ sessionId: 's1', title: 'T', branch: null, prompt: 'p', status: 'proposed', detail: null }],
    });
    store.saveBulkRun(run('a', '2026-09-23T10:00:00.000Z'));
    store.saveBulkRun(run('b', '2026-09-23T11:00:00.000Z'));
    store.saveBulkRun(run('a', '2026-09-23T10:00:00.000Z', 'running'));
    expect(store.loadBulkRuns(10).map((r) => [r.id, r.status])).toEqual([['b', 'proposed'], ['a', 'running']]);
    expect(store.loadBulkRuns(1).map((r) => r.id)).toEqual(['b']);
  });
```
(import `type BulkRun` from `@relay/shared`.) Run → FAIL.
- [ ] **Step 2:** In the constructor `exec` add `create table if not exists bulk_runs (id text primary key, created_at text not null, run text not null);` and:
```ts
  saveBulkRun(run: BulkRun): void {
    this.db
      .prepare('insert into bulk_runs (id, created_at, run) values (?, ?, ?) on conflict(id) do update set run = excluded.run')
      .run(run.id, run.createdAt, JSON.stringify(run));
  }

  loadBulkRuns(limit: number): BulkRun[] {
    const rows = this.db.prepare('select run from bulk_runs order by created_at desc limit ?').all(limit) as { run: string }[];
    return rows.map((r) => JSON.parse(r.run) as BulkRun);
  }
```
- [ ] **Step 3:** → PASS. Commit `feat(engine): persist bulk runs`.

---

### Task 3: BulkRuns

**Files:** Create `packages/engine/src/bulk/bulk-runs.ts`; test `packages/engine/test/bulk/bulk-runs.test.ts`.

**Interfaces:**
- Consumes: `BulkRun`, `BulkRow`, `DeliveryMode`, `MessageOrigin` (Task 1); `TurnEnd` (M3, `runner/session-runner.ts`).
- Produces:
  ```ts
  export const BULK_CONCURRENCY = 3;
  export const bulkOrigin = (runId: string): MessageOrigin => `bulk:${runId}`;
  export interface BulkRunsDeps {
    send(req: { sessionId: string; prompt: string; mode: DeliveryMode; origin: MessageOrigin }): Promise<string>;
    now?: () => Date;
    concurrency?: number;
  }
  class BulkRuns extends EventEmitter<{ changed: [BulkRun]; finished: [BulkRun] }> {
    constructor(deps: BulkRunsDeps, initial?: BulkRun[])        // initial = loaded from the store, already repaired
    propose(targets: { sessionId: string; title: string; branch: string | null; prompt: string }[], mode: DeliveryMode): BulkRun
    confirm(runId: string, sessionIds: string[]): void           // throws on unknown / not proposed
    cancel(runId: string): void                                   // throws on unknown / not proposed
    onTurnEnd(sessionId: string, end: TurnEnd): void              // called by the engine for every session turn-end
    recent(limit: number): BulkRun[]                              // newest first
  }
  export function repairLoadedRuns(runs: BulkRun[]): BulkRun[]   // closed-mid-run fix-up (Global Constraints)
  ```
  Runs are immutable snapshots on the outside: every change replaces the stored object and emits `changed` with a copy.

- [ ] **Step 1 (red):** `packages/engine/test/bulk/bulk-runs.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import type { BulkRun } from '@relay/shared';
import { BulkRuns, bulkOrigin, repairLoadedRuns } from '../../src/bulk/bulk-runs';

const tick = () => new Promise((r) => setTimeout(r, 0));
const targets = (...ids: string[]) =>
  ids.map((id) => ({ sessionId: id, title: `T-${id}`, branch: `b-${id}`, prompt: `do ${id}` }));

function setup(concurrency = 3, refuse: Record<string, string> = {}) {
  const sent: { sessionId: string; origin: string }[] = [];
  const runs = new BulkRuns({
    concurrency,
    now: () => new Date('2026-09-23T12:00:00.000Z'),
    send: async (req) => {
      if (refuse[req.sessionId]) throw new Error(refuse[req.sessionId]);
      sent.push({ sessionId: req.sessionId, origin: req.origin });
      return `m-${req.sessionId}`;
    },
  });
  const changes: BulkRun[] = [];
  const finished: BulkRun[] = [];
  runs.on('changed', (r) => changes.push(r));
  runs.on('finished', (r) => finished.push(r));
  return { runs, sent, changes, finished };
}

const statuses = (r: BulkRun) => r.rows.map((x) => `${x.sessionId}:${x.status}`);
const done = (runs: BulkRuns, runId: string, sessionId: string, text = 'ok') =>
  runs.onTurnEnd(sessionId, { origins: [bulkOrigin(runId)], lastText: text, error: null });

describe('BulkRuns', () => {
  it('proposes a run with every row proposed and sends nothing', () => {
    const { runs, sent } = setup();
    const run = runs.propose(targets('a', 'b'), 'steer');
    expect(run).toMatchObject({ status: 'proposed', mode: 'steer', createdAt: '2026-09-23T12:00:00.000Z' });
    expect(statuses(run)).toEqual(['a:proposed', 'b:proposed']);
    expect(sent).toEqual([]);
  });

  it('confirm skips unticked rows and starts at most `concurrency` rows, the rest queued', async () => {
    const { runs, sent } = setup(2);
    const run = runs.propose(targets('a', 'b', 'c', 'd'), 'steer');
    runs.confirm(run.id, ['a', 'b', 'c']);
    await tick();
    const now = runs.recent(1)[0]!;
    expect(now.status).toBe('running');
    expect(statuses(now)).toEqual(['a:running', 'b:running', 'c:queued', 'd:skipped']);
    expect(sent).toEqual([
      { sessionId: 'a', origin: `bulk:${run.id}` },
      { sessionId: 'b', origin: `bulk:${run.id}` },
    ]);
  });

  it('a finished row starts the next queued one; the run finishes once every row is settled', async () => {
    const { runs, sent, finished } = setup(1);
    const run = runs.propose(targets('a', 'b'), 'steer');
    runs.confirm(run.id, ['a', 'b']);
    await tick();
    done(runs, run.id, 'a', 'Added tests.');
    await tick();
    expect(sent.map((s) => s.sessionId)).toEqual(['a', 'b']);
    expect(finished).toEqual([]);
    runs.onTurnEnd('b', { origins: [bulkOrigin(run.id)], lastText: null, error: 'api error' });
    await tick();
    const last = runs.recent(1)[0]!;
    expect(last.status).toBe('finished');
    expect(last.rows.map((r) => [r.status, r.detail])).toEqual([['done', 'Added tests.'], ['error', 'api error']]);
    expect(finished).toHaveLength(1);
  });

  it('a refused send marks only that row as error and the rest go on', async () => {
    const { runs, sent } = setup(3, { b: 'Session b is open in another Claude process (pid 7)' });
    const run = runs.propose(targets('a', 'b', 'c'), 'steer');
    runs.confirm(run.id, ['a', 'b', 'c']);
    await tick();
    const now = runs.recent(1)[0]!;
    expect(statuses(now)).toEqual(['a:running', 'b:error', 'c:running']);
    expect(now.rows[1]!.detail).toBe('Session b is open in another Claude process (pid 7)');
    expect(sent.map((s) => s.sessionId)).toEqual(['a', 'c']);
  });

  it('ignores turn-ends that are not from this run, and recognises its origin among others', async () => {
    const { runs } = setup();
    const run = runs.propose(targets('a'), 'steer');
    runs.confirm(run.id, ['a']);
    await tick();
    runs.onTurnEnd('a', { origins: ['user'], lastText: 'x', error: null });
    expect(statuses(runs.recent(1)[0]!)).toEqual(['a:running']);
    runs.onTurnEnd('a', { origins: ['user', bulkOrigin(run.id)], lastText: 'y', error: null });
    expect(statuses(runs.recent(1)[0]!)).toEqual(['a:done']);
  });

  it('confirming with nothing ticked cancels the run', async () => {
    const { runs, sent, finished } = setup();
    const run = runs.propose(targets('a', 'b'), 'steer');
    runs.confirm(run.id, []);
    await tick();
    expect(runs.recent(1)[0]!.status).toBe('cancelled');
    expect(sent).toEqual([]);
    expect(finished).toEqual([]);
  });

  it('cancel, double confirm and unknown ids throw and change nothing', async () => {
    const { runs } = setup();
    const run = runs.propose(targets('a'), 'steer');
    expect(() => runs.confirm('nope', ['a'])).toThrow(/unknown bulk run/i);
    runs.cancel(run.id);
    expect(runs.recent(1)[0]!.status).toBe('cancelled');
    expect(() => runs.confirm(run.id, ['a'])).toThrow(/not waiting for confirmation/i);
    expect(() => runs.cancel(run.id)).toThrow(/not waiting for confirmation/i);
  });

  it('emits a changed snapshot on every transition and never exposes its internal objects', async () => {
    const { runs, changes } = setup();
    const run = runs.propose(targets('a'), 'steer');
    run.rows[0]!.status = 'done'; // mutating the returned snapshot must not leak in
    runs.confirm(run.id, ['a']);
    await tick();
    expect(changes.map((c) => c.status)).toEqual(['proposed', 'running', 'running']);
    expect(runs.recent(1)[0]!.rows[0]!.status).toBe('running');
  });
});

describe('repairLoadedRuns', () => {
  it('finishes runs that were running when Relay closed and cancels unconfirmed ones', () => {
    const row = (status: BulkRun['rows'][number]['status']) => ({ sessionId: status, title: 't', branch: null, prompt: 'p', status, detail: null });
    const repaired = repairLoadedRuns([
      { id: 'r1', createdAt: 'x', mode: 'steer', status: 'running', rows: [row('done'), row('running'), row('queued')] },
      { id: 'r2', createdAt: 'x', mode: 'steer', status: 'proposed', rows: [row('proposed')] },
      { id: 'r3', createdAt: 'x', mode: 'steer', status: 'finished', rows: [row('done')] },
    ]);
    expect(repaired.map((r) => r.status)).toEqual(['finished', 'cancelled', 'finished']);
    expect(repaired[0]!.rows.map((r) => [r.status, r.detail])).toEqual([
      ['done', null],
      ['error', 'Relay was closed during the run'],
      ['error', 'Relay was closed during the run'],
    ]);
  });
});
```
Run `pnpm --filter @relay/engine test bulk-runs` → FAIL (module not found).

- [ ] **Step 2:** `packages/engine/src/bulk/bulk-runs.ts`:
```ts
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { BulkRow, BulkRun, DeliveryMode, MessageOrigin } from '@relay/shared';
import type { TurnEnd } from '../runner/session-runner';

export const BULK_CONCURRENCY = 3;
const CLOSED_MID_RUN = 'Relay was closed during the run';

export const bulkOrigin = (runId: string): MessageOrigin => `bulk:${runId}`;

export interface BulkTarget {
  sessionId: string;
  title: string;
  branch: string | null;
  prompt: string;
}

export interface BulkRunsDeps {
  send(req: { sessionId: string; prompt: string; mode: DeliveryMode; origin: MessageOrigin }): Promise<string>;
  now?: () => Date;
  concurrency?: number;
}

type BulkEvents = { changed: [BulkRun]; finished: [BulkRun] };

const copy = (run: BulkRun): BulkRun => ({ ...run, rows: run.rows.map((r) => ({ ...r })) });
const settled = (r: BulkRow) => r.status === 'done' || r.status === 'error' || r.status === 'skipped';

/** Runs loaded after a restart: nothing is still running, and nothing waits for a confirm nobody can give. */
export function repairLoadedRuns(runs: BulkRun[]): BulkRun[] {
  return runs.map((run) => {
    if (run.status === 'proposed') return { ...copy(run), status: 'cancelled' };
    if (run.status !== 'running') return copy(run);
    return {
      ...run,
      status: 'finished',
      rows: run.rows.map((r) => (settled(r) ? { ...r } : { ...r, status: 'error', detail: CLOSED_MID_RUN })),
    };
  });
}

/** One instruction for many sessions: proposed, confirmed by the user, then run a few at a time. */
export class BulkRuns extends EventEmitter<BulkEvents> {
  private readonly runs = new Map<string, BulkRun>();
  private readonly now: () => Date;
  private readonly concurrency: number;

  constructor(
    private readonly deps: BulkRunsDeps,
    initial: BulkRun[] = [],
  ) {
    super();
    this.now = deps.now ?? (() => new Date());
    this.concurrency = deps.concurrency ?? BULK_CONCURRENCY;
    for (const run of initial) this.runs.set(run.id, copy(run));
  }

  propose(targets: BulkTarget[], mode: DeliveryMode): BulkRun {
    const run: BulkRun = {
      id: randomUUID(),
      createdAt: this.now().toISOString(),
      mode,
      status: 'proposed',
      rows: targets.map((t) => ({ ...t, status: 'proposed', detail: null })),
    };
    this.runs.set(run.id, run);
    this.changed(run);
    return copy(run);
  }

  confirm(runId: string, sessionIds: string[]): void {
    const run = this.proposed(runId);
    const picked = new Set(sessionIds);
    for (const row of run.rows) row.status = picked.has(row.sessionId) ? 'queued' : 'skipped';
    run.status = run.rows.some((r) => r.status === 'queued') ? 'running' : 'cancelled';
    this.changed(run);
    if (run.status === 'running') this.pump(run);
  }

  cancel(runId: string): void {
    const run = this.proposed(runId);
    run.status = 'cancelled';
    this.changed(run);
  }

  /** Every session turn-end goes through here; only rows of the run named in its origins move. */
  onTurnEnd(sessionId: string, end: { origins: MessageOrigin[]; lastText: string | null; error: string | null }): void {
    for (const origin of end.origins) {
      if (!origin.startsWith('bulk:')) continue;
      const run = this.runs.get(origin.slice('bulk:'.length));
      const row = run?.rows.find((r) => r.sessionId === sessionId && r.status === 'running');
      if (!run || !row) continue;
      row.status = end.error ? 'error' : 'done';
      row.detail = end.error ?? end.lastText;
      this.changed(run);
      this.pump(run);
    }
  }

  recent(limit: number): BulkRun[] {
    return [...this.runs.values()]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit)
      .map(copy);
  }

  private proposed(runId: string): BulkRun {
    const run = this.runs.get(runId);
    if (!run) throw new Error(`Unknown bulk run ${runId}`);
    if (run.status !== 'proposed') throw new Error(`Bulk run ${runId} is not waiting for confirmation (${run.status})`);
    return run;
  }

  /** Starts queued rows up to the cap; finishes the run once every row is settled. */
  private pump(run: BulkRun): void {
    if (run.status !== 'running') return;
    let running = run.rows.filter((r) => r.status === 'running').length;
    for (const row of run.rows) {
      if (running >= this.concurrency) break;
      if (row.status !== 'queued') continue;
      row.status = 'running';
      running += 1;
      this.deps
        .send({ sessionId: row.sessionId, prompt: row.prompt, mode: run.mode, origin: bulkOrigin(run.id) })
        .catch((err: unknown) => {
          row.status = 'error';
          row.detail = err instanceof Error ? err.message : String(err);
          this.changed(run);
          this.pump(run);
        });
    }
    this.changed(run);
    if (run.rows.every(settled)) {
      run.status = 'finished';
      this.changed(run);
      this.emit('finished', copy(run));
    }
  }

  private changed(run: BulkRun): void {
    this.emit('changed', copy(run));
  }
}
```
Notes for the implementer: `pump` emits `changed` after starting rows even when nothing started; the snapshot test in Step 1 expects exactly `['proposed', 'running', 'running']` after propose + confirm (confirm's own emit, then pump's). If that count differs, adjust `pump` to emit only when it changed a row or finished the run, and update the test's expectation in the same edit — record it as a ruling.

- [ ] **Step 3:** → PASS; typecheck. Commit `feat(engine): bulk runs — propose, confirm, concurrency cap, per-row progress`.

---

### Task 4: Engine integration

**Files:** Modify `packages/engine/src/relay-engine.ts`, `packages/engine/src/orchestrator/relay-tools.ts`, `packages/engine/src/orchestrator/system-prompt.ts`, `packages/engine/src/index.ts`; tests `packages/engine/test/relay-engine.test.ts`, `packages/engine/test/orchestrator/relay-tools.test.ts`.

**Interfaces:**
- Consumes: `BulkRuns`, `repairLoadedRuns`, `bulkOrigin` (Task 3); `saveBulkRun`, `loadBulkRuns` (Task 2).
- Produces:
  ```ts
  RelayToolDeps += { proposeBulk(targets: { sessionId: string; prompt: string }[], mode: DeliveryMode): Promise<BulkRun> }
  tool 'propose_bulk_action' { targets: { id: string; prompt?: string }[] (min 2), prompt: string, mode?: steer|queue|interrupt }
  RelayEngine.bulkConfirm(runId: string, sessionIds: string[]): void
  RelayEngine.bulkCancel(runId: string): void
  runState().bulkRuns: BulkRun[]   // 20 most recent
  ```
  Engine behaviour:
  - `proposeBulk` resolves each target through `listSessions()`; an unknown id rejects with `Unknown session <id>` (whole proposal refused); duplicate ids are collapsed; the per-target `prompt` falls back to the shared one. Same relay-only guard as `send`.
  - `BulkRuns.send` is `this.send` (so busy checks, runner creation and serialization all apply per row).
  - Every `changed` → `store.saveBulkRun(run)` + `publish({ type: 'bulk', run })`.
  - Every session runner's `turn-end` → `bulk.onTurnEnd(sessionId, end)` (before `relayTurnEnd`, which already ignores non-`orchestrator` origins).
  - `finished` → one relay to the orchestrator, mode `queue`, origin `watch:bulk-end`, text:
    `[bulk-end] run <id>: <n done> done, <n error> error, <n skipped> skipped.` followed by one line per non-skipped row: `- "<title>" (<sessionId>): <status>[: <detail clipped to 200>]`. Skipped while `closing`.
  - On start: `new BulkRuns({ send }, repairLoadedRuns(store.loadBulkRuns(20)))` and save each repaired run back.

- [ ] **Step 1 (red) — tool:** in `relay-tools.test.ts` add `proposeBulk: vi.fn(async (targets, mode) => ({ id: 'r1', createdAt: 'x', mode, status: 'proposed', rows: targets.map((t) => ({ sessionId: t.sessionId, title: 't', branch: null, prompt: t.prompt, status: 'proposed', detail: null })) }))` to `deps()`; change the "exposes exactly" expectation to include `'propose_bulk_action'` last; and add:
```ts
  it('propose_bulk_action proposes with per-target prompts falling back to the shared one', async () => {
    const d = deps();
    const r = await call(d, 'propose_bulk_action', { targets: [{ id: 'a' }, { id: 'b', prompt: 'special' }], prompt: 'rebase onto main' });
    expect(d.proposeBulk).toHaveBeenCalledWith(
      [{ sessionId: 'a', prompt: 'rebase onto main' }, { sessionId: 'b', prompt: 'special' }], 'steer',
    );
    expect(JSON.parse(r.text)).toMatchObject({ bulkRunId: 'r1', status: 'proposed', rows: 2 });
  });

  it('propose_bulk_action reports a refusal as a tool error', async () => {
    const d = deps({ proposeBulk: async () => { throw new Error('Unknown session zz'); } });
    expect(await call(d, 'propose_bulk_action', { targets: [{ id: 'a' }, { id: 'zz' }], prompt: 'x' })).toEqual({
      text: 'Unknown session zz', isError: true,
    });
  });
```
- [ ] **Step 2 (red) — engine:** add to `relay-engine.test.ts` (reuse `routed()` from M3; `startWithBasic` creates `s-basic`; add a helper that writes a second fixture session `s-two` with its own existing cwd before start — extend `startWithBasic` with `extra.more?: boolean` that also writes `projects/p/s-two.jsonl` from `basic.jsonl` with `s-basic`→`s-two` and cwd `wt-b`, mtime old):
```ts
  it('a proposed bulk run sends nothing until confirmed, then runs rows and relays one summary', async () => {
    const { orchClient, sessionClient, router } = routed();
    await startWithBasic(router, undefined, { more: true });
    const events: RunnerEvent[] = [];
    engine!.onEvent((e) => events.push(e));
    await engine!.orchestratorSend('rebase both');
    await tick();
    const r = await orchClient.callTool('propose_bulk_action', {
      targets: [{ id: 's-basic' }, { id: 's-two' }], prompt: 'rebase onto main',
    });
    const { bulkRunId } = JSON.parse(r.text);
    await tick();
    expect(sessionClient.starts).toHaveLength(0);
    expect(engine!.runState().bulkRuns[0]).toMatchObject({ id: bulkRunId, status: 'proposed' });
    expect(events.some((e) => e.type === 'bulk' && e.run.id === bulkRunId)).toBe(true);

    engine!.bulkConfirm(bulkRunId, ['s-basic', 's-two']);
    await tick();
    await tick();
    expect(sessionClient.received.map((m) => [m.text, m.origin])).toEqual([
      ['rebase onto main', `bulk:${bulkRunId}`],
      ['rebase onto main', `bulk:${bulkRunId}`],
    ]);
  });
```
  The fake client routes all session runs to one `sessionClient` whose `result()` settles only its **last** run; for the full finish-and-relay path use two session clients keyed by `opts.sessionId`:
```ts
  it('relays one [bulk-end] summary when every confirmed row has settled, and none per row', async () => {
    const orchClient = new FakeAgentClient();
    const perSession = new Map<string, FakeAgentClient>();
    const router: AgentClient = {
      start: (opts) => {
        if (opts.profile?.kind === 'orchestrator') return orchClient.start(opts);
        const c = perSession.get(opts.sessionId!) ?? new FakeAgentClient();
        perSession.set(opts.sessionId!, c);
        return c.start(opts);
      },
    };
    await startWithBasic(router, undefined, { more: true });
    await engine!.orchestratorSend('rebase both');
    await tick();
    const { bulkRunId } = JSON.parse(
      (await orchClient.callTool('propose_bulk_action', { targets: [{ id: 's-basic' }, { id: 's-two' }], prompt: 'rebase' })).text,
    );
    engine!.bulkConfirm(bulkRunId, ['s-basic', 's-two']);
    await tick();
    await tick();
    perSession.get('s-basic')!.assistant('a1', 'Rebased cleanly.');
    perSession.get('s-basic')!.result();
    await tick();
    expect(orchClient.received.filter((m) => m.origin.startsWith('watch:'))).toHaveLength(0);
    perSession.get('s-two')!.result('conflict in a.ts');
    await tick();
    const relayed = orchClient.received.filter((m) => m.origin === 'watch:bulk-end');
    expect(relayed).toHaveLength(1);
    expect(relayed[0]!.text).toBe(
      `[bulk-end] run ${bulkRunId}: 1 done, 1 error, 0 skipped.\n` +
        '- "Add tests for the zero-rate case" (s-basic): done: Rebased cleanly.\n' +
        '- "Add tests for the zero-rate case" (s-two): error: conflict in a.ts',
    );
    expect(engine!.runState().bulkRuns[0]!.status).toBe('finished');
  });

  it('propose_bulk_action refuses a plan with an unknown session', async () => {
    const { orchClient, router } = routed();
    await startWithBasic(router);
    await engine!.orchestratorSend('x');
    await tick();
    const bad = await orchClient.callTool('propose_bulk_action', { targets: [{ id: 's-basic' }, { id: 'nope' }], prompt: 'x' });
    expect(bad).toMatchObject({ isError: true, text: 'Unknown session nope' });
    expect(engine!.runState().bulkRuns).toEqual([]);
  });

  it('a run still going when Relay closed is finished with errors on the next start', async () => {
    const { orchClient, router } = routed();
    await startWithBasic(router, undefined, { more: true });
    await engine!.orchestratorSend('x');
    await tick();
    const { bulkRunId } = JSON.parse(
      (await orchClient.callTool('propose_bulk_action', { targets: [{ id: 's-basic' }, { id: 's-two' }], prompt: 'p' })).text,
    );
    engine!.bulkConfirm(bulkRunId, ['s-basic', 's-two']);
    await tick();
    await engine!.close();
    engine = await RelayEngine.start({
      projectsDir: join(root, 'projects'), dbPath: join(root, 'relay.db'), orchestratorDir: join(root, 'orch'),
      agent: new FakeAgentClient(), git: { inspect: async () => ({ branch: 'feat/a', repo: 'r' }) },
    });
    const run = engine.runState().bulkRuns[0]!;
    expect(run.status).toBe('finished');
    expect(run.rows.every((r) => r.status === 'error' || r.status === 'done')).toBe(true);
  });
```
  (`perSession.get(opts.sessionId!)`: session runs always have a session id; the `!` is fine in a test.) Run → FAIL.

- [ ] **Step 3:** Implementation.
  - `relay-tools.ts`: add `proposeBulk` to `RelayToolDeps` and the tool:
```ts
  const proposeBulk: AgentTool<{
    targets: z.ZodArray<z.ZodObject<{ id: z.ZodString; prompt: z.ZodOptional<z.ZodString> }>>;
    prompt: z.ZodString;
    mode: z.ZodOptional<z.ZodEnum<{ steer: 'steer'; queue: 'queue'; interrupt: 'interrupt' }>>;
  }> = {
    name: 'propose_bulk_action',
    description:
      'Propose one instruction for several sessions. The user sees a plan card, can untick rows, and must confirm; ' +
      'nothing runs before that. A "[bulk-end]" message arrives when all confirmed rows finish. ' +
      'A target may override the shared prompt.',
    input: {
      targets: z.array(z.object({ id: z.string(), prompt: z.string().optional() })).min(2),
      prompt: z.string(),
      mode: z.enum(['steer', 'queue', 'interrupt']).optional(),
    },
    handler: async ({ targets, prompt, mode }) => {
      try {
        const run = await deps.proposeBulk(
          targets.map((t) => ({ sessionId: t.id, prompt: t.prompt ?? prompt })),
          mode ?? 'steer',
        );
        return ok({
          bulkRunId: run.id,
          status: run.status,
          rows: run.rows.length,
          note: 'Waiting for the user to confirm the plan card. Do not send to these sessions yourself.',
        });
      } catch (err) {
        return fail(err);
      }
    },
  };
```
    and return it last in the array.
  - `system-prompt.ts`: replace the "Send to one session per request…" line with `- More than one target always goes through propose_bulk_action: one call with every target; the user confirms it in a plan card. Never loop send_to_session over several sessions.` and add `- A "[bulk-end]" message summarises a bulk run: report it to the user in a few lines, highlighting the rows that failed.`
  - `relay-engine.ts`:
    - field `private readonly bulk: BulkRuns;`. In `start()` after the store: `const loaded = repairLoadedRuns(store.loadBulkRuns(20)); for (const r of loaded) store.saveBulkRun(r);` and pass `loaded` to the constructor.
    - constructor: `this.bulk = new BulkRuns({ send: (req) => this.send(req) }, loaded);` then
      `this.bulk.on('changed', (run) => { this.store.saveBulkRun(run); this.publish({ type: 'bulk', run }); });`
      `this.bulk.on('finished', (run) => this.relayBulkEnd(run));`
    - extract the relay-only guard into `private refuseRelayOnly(): void` (throws the M3 message) and use it in both `send` and `proposeBulk` tool deps.
    - tool dep `proposeBulk: async (targets, mode) => { this.refuseRelayOnly(); const known = this.listSessions(); const seen = new Set<string>(); const resolved = []; for (const t of targets) { if (seen.has(t.sessionId)) continue; seen.add(t.sessionId); const s = known.find((x) => x.id === t.sessionId); if (!s) throw new Error(`Unknown session ${t.sessionId}`); resolved.push({ sessionId: s.id, title: s.title, branch: s.branch, prompt: t.prompt }); } return this.bulk.propose(resolved, mode); }`
    - `bulkConfirm(runId, sessionIds) { this.bulk.confirm(runId, sessionIds); }`, `bulkCancel(runId) { this.bulk.cancel(runId); }`.
    - `runState()` → `bulkRuns: this.bulk.recent(20)`.
    - in `createRunner`, before the `relayTurnEnd` listener: `runner.on('turn-end', (end) => this.bulk.onTurnEnd(sessionId, end));`
    - ```ts
      private relayBulkEnd(run: BulkRun): void {
        if (this.closing) return;
        const count = (s: BulkRowStatus) => run.rows.filter((r) => r.status === s).length;
        const lines = run.rows
          .filter((r) => r.status !== 'skipped')
          .map((r) => `- "${r.title}" (${r.sessionId}): ${r.status}${r.detail ? `: ${clip(r.detail, 200)}` : ''}`);
        const head = `[bulk-end] run ${run.id}: ${count('done')} done, ${count('error')} error, ${count('skipped')} skipped.`;
        void this.orchestrator.send([head, ...lines].join('\n'), { origin: 'watch:bulk-end', mode: 'queue' });
      }
      ```
      with a module-level `const clip = (t: string, max: number) => (t.length > max ? `${t.slice(0, max)}…` : t);` — and use the same `clip` in `relayTurnEnd` in place of its inline ternary (one helper, two callers now).
  - `index.ts`: export `BulkRuns`, `BULK_CONCURRENCY`, `bulkOrigin`, `repairLoadedRuns`.
- [ ] **Step 4:** `pnpm --filter @relay/engine test && pnpm typecheck` → green (desktop typecheck may fail on `bulkConfirm` missing in `ipc.ts` — no: `ipc.ts` only calls engine methods it registers; it is fine until Task 5). Commit `feat(engine): propose_bulk_action, bulk runs in the engine, one summary per run`.

---

### Task 5: Desktop IPC

**Files:** Modify `apps/desktop/src/ipc.ts`.

- [ ] **Step 1:** `handle(IPC.bulkConfirm, (runId: string, sessionIds: string[]) => engine.bulkConfirm(runId, sessionIds));` and `handle(IPC.bulkCancel, (runId: string) => engine.bulkCancel(runId));`; add both to `channels`.
- [ ] **Step 2:** `pnpm typecheck && pnpm --filter @relay/desktop test:e2e` → green. Commit `feat(desktop): bulk confirm and cancel over IPC`.

---

### Task 6: Plan card in the chat

**Files:** Create `apps/desktop/src/ui/BulkRunCard.tsx`, `apps/desktop/src/ui/BulkRunCard.test.tsx`; modify `apps/desktop/src/ui/useRunState.ts`, `apps/desktop/src/ui/OrchestratorChat.tsx`, `apps/desktop/src/ui/OrchestratorChat.test.tsx`, `apps/desktop/src/ui/App.tsx`, `apps/desktop/src/ui/styles.css`.

**Interfaces:**
- Produces:
  - `RunView.bulkRuns: BulkRun[]` in `useRunState` (snapshot from `runState()`, then each `bulk` event replaces the run with the same id or prepends a new one; newest first).
  - `<BulkRunCard run onConfirm(sessionIds) onCancel />`:
    - `proposed`: header "Plan: N sessions", one row per target with a checkbox (all ticked by default, `aria-label` = row title), the session title + branch, the prompt; buttons **Run on K sessions** (K = ticked count; disabled when 0) and **Cancel**.
    - `running`/`finished`/`cancelled`: header with the status and counts (`2/5 done, 1 error`), rows with a status badge and the detail text (clipped to 160 chars) — no checkboxes, no buttons.
  - `OrchestratorChat` gets `bulkRuns` and `onBulkConfirm(runId, ids)` / `onBulkCancel(runId)` props and renders cards interleaved with entries by time (`run.createdAt` vs `entry.timestamp`; a card goes after every entry at or before its `createdAt`). `[bulk-end]` user entries render as Relay update lines, like `[turn-end]`.

- [ ] **Step 1 (red):** `BulkRunCard.test.tsx`:
```tsx
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { BulkRun } from '@relay/shared';
import { BulkRunCard } from './BulkRunCard';

const run = (over: Partial<BulkRun> = {}): BulkRun => ({
  id: 'r1', createdAt: '2026-09-23T12:00:00.000Z', mode: 'steer', status: 'proposed',
  rows: [
    { sessionId: 'a', title: 'Mileage', branch: 'feat/mileage', prompt: 'rebase onto main', status: 'proposed', detail: null },
    { sessionId: 'b', title: 'OCR', branch: 'feat/ocr', prompt: 'rebase onto main', status: 'proposed', detail: null },
  ],
  ...over,
});

describe('BulkRunCard', () => {
  it('lets the user untick rows and confirms only the ticked ones', async () => {
    const onConfirm = vi.fn();
    render(<BulkRunCard run={run()} onConfirm={onConfirm} onCancel={vi.fn()} />);
    expect(screen.getByText('Plan: 2 sessions')).toBeInTheDocument();
    await userEvent.click(screen.getByLabelText('OCR'));
    await userEvent.click(screen.getByRole('button', { name: 'Run on 1 session' }));
    expect(onConfirm).toHaveBeenCalledWith(['a']);
  });

  it('disables run when nothing is ticked, and cancel calls back', async () => {
    const onCancel = vi.fn();
    render(<BulkRunCard run={run()} onConfirm={vi.fn()} onCancel={onCancel} />);
    await userEvent.click(screen.getByLabelText('Mileage'));
    await userEvent.click(screen.getByLabelText('OCR'));
    expect(screen.getByRole('button', { name: 'Run on 0 sessions' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalled();
  });

  it('shows progress without controls once running', () => {
    render(
      <BulkRunCard
        run={run({
          status: 'running',
          rows: [
            { sessionId: 'a', title: 'Mileage', branch: null, prompt: 'p', status: 'done', detail: 'Rebased cleanly.' },
            { sessionId: 'b', title: 'OCR', branch: null, prompt: 'p', status: 'error', detail: 'conflict in a.ts' },
          ],
        })}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByText('running · 1/2 done, 1 error')).toBeInTheDocument();
    expect(screen.getByText('Rebased cleanly.')).toBeInTheDocument();
    expect(screen.getByText('conflict in a.ts')).toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
```
In `OrchestratorChat.test.tsx` add: a card with `createdAt` between two history entries renders between them (assert via `compareDocumentPosition` on the two texts and the card header), and `[bulk-end] run r1: …` renders as a Relay update. Existing `OrchestratorChat` renders gain `bulkRuns={[]} onBulkConfirm={vi.fn()} onBulkCancel={vi.fn()}`. In `App.test.tsx` add: a `bulk` runner event shows a "Plan: 2 sessions" card in the Orchestrator column; clicking **Run on 2 sessions** calls `bulkConfirm('r1', ['a', 'b'])`. Run → FAIL.

- [ ] **Step 2:** `BulkRunCard.tsx`:
```tsx
import { useState } from 'react';
import type { BulkRun } from '@relay/shared';

interface Props {
  run: BulkRun;
  onConfirm: (sessionIds: string[]) => void;
  onCancel: () => void;
}

const DETAIL_MAX = 160;
const clip = (t: string) => (t.length > DETAIL_MAX ? `${t.slice(0, DETAIL_MAX)}…` : t);
const plural = (n: number) => `${n} session${n === 1 ? '' : 's'}`;

/** A bulk run in the chat: a plan to confirm, then its per-row progress. */
export function BulkRunCard({ run, onConfirm, onCancel }: Props) {
  const [ticked, setTicked] = useState(() => new Set(run.rows.map((r) => r.sessionId)));
  const toggle = (id: string) =>
    setTicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  if (run.status === 'proposed') {
    return (
      <section className="bulk-card" aria-label="Bulk plan">
        <h3>Plan: {plural(run.rows.length)}</h3>
        <ul>
          {run.rows.map((r) => (
            <li key={r.sessionId}>
              <label>
                <input type="checkbox" aria-label={r.title} checked={ticked.has(r.sessionId)} onChange={() => toggle(r.sessionId)} />
                <strong>{r.title}</strong> {r.branch && <code>{r.branch}</code>}
              </label>
              <p className="bulk-card__prompt">{r.prompt}</p>
            </li>
          ))}
        </ul>
        <div className="bulk-card__actions">
          <button type="button" disabled={ticked.size === 0} onClick={() => onConfirm(run.rows.map((r) => r.sessionId).filter((id) => ticked.has(id)))}>
            Run on {plural(ticked.size)}
          </button>
          <button type="button" onClick={onCancel}>Cancel</button>
        </div>
      </section>
    );
  }

  const active = run.rows.filter((r) => r.status !== 'skipped');
  const done = active.filter((r) => r.status === 'done').length;
  const errors = active.filter((r) => r.status === 'error').length;
  return (
    <section className="bulk-card" aria-label="Bulk run">
      <h3>
        {run.status} · {done}/{active.length} done{errors ? `, ${errors} error${errors === 1 ? '' : 's'}` : ''}
      </h3>
      <ul>
        {run.rows.map((r) => (
          <li key={r.sessionId} className={`bulk-row bulk-row--${r.status}`}>
            <span className={`state state--${r.status}`}>{r.status}</span> <strong>{r.title}</strong>
            {r.detail && <p className="bulk-card__detail">{clip(r.detail)}</p>}
          </li>
        ))}
      </ul>
    </section>
  );
}
```
  `useRunState.ts`: add `bulkRuns: BulkRun[]` to `RunView` (initial `[]`; snapshot sets `s.bulkRuns`), and the event case:
  ```ts
  case 'bulk': {
    const others = v.bulkRuns.filter((r) => r.id !== event.run.id);
    return { ...v, bulkRuns: [event.run, ...others].sort((a, b) => b.createdAt.localeCompare(a.createdAt)) };
  }
  ```
  `OrchestratorChat.tsx`: new props; build one timeline:
  ```ts
  type Item = { kind: 'entry'; at: string; entry: ViewEntry } | { kind: 'bulk'; at: string; run: BulkRun };
  const timeline: Item[] = [
    ...entries.map((entry) => ({ kind: 'entry' as const, at: entry.timestamp, entry })),
    ...bulkRuns.map((run) => ({ kind: 'bulk' as const, at: run.createdAt, run })),
  ].sort((a, b) => a.at.localeCompare(b.at) || (a.kind === 'entry' ? -1 : 1));
  ```
  (`Array.prototype.sort` is stable, so entries with equal timestamps keep their order.) Render `bulk` items as `<BulkRunCard key={run.id} run={run} onConfirm={(ids) => onBulkConfirm(run.id, ids)} onCancel={() => onBulkCancel(run.id)} />`. Extend the relay-update prefix check to `[turn-end] ` **and** `[bulk-end] ` (a `RELAY_PREFIXES` array). Follow-bottom deps become `[timeline.length, bulkRuns]`.
  `App.tsx`: pass `bulkRuns={run.bulkRuns}`, `onBulkConfirm={(id, ids) => void window.relay.bulkConfirm(id, ids)}`, `onBulkCancel={(id) => void window.relay.bulkCancel(id)}`.
  Styles:
  ```css
  .bulk-card { border: 1px solid color-mix(in srgb, currentColor 25%, transparent); border-radius: 8px; padding: 8px 10px; margin: 0 0 12px; }
  .bulk-card h3 { font-size: 13px; margin: 0 0 6px; }
  .bulk-card ul { list-style: none; margin: 0; padding: 0; }
  .bulk-card li { margin: 0 0 6px; }
  .bulk-card__prompt, .bulk-card__detail { margin: 2px 0 0 22px; font-size: 12px; opacity: .75; white-space: pre-wrap; }
  .bulk-card__actions { display: flex; gap: 6px; margin-top: 8px; }
  .state--done { color: #2e9d57; } .state--queued, .state--skipped, .state--proposed { opacity: .6; }
  ```
- [ ] **Step 3:** `pnpm --filter @relay/desktop test && pnpm typecheck` → green. Commit `feat(desktop): bulk plan cards in the chat`.

---

### Task 7: Live check, README

**Files:** Modify `packages/engine/test/live/sdk-live.test.ts`, `README.md`.

- [ ] **Step 1:** A second scratch session is needed. Create it once (tokens: one short turn): `mkdir -p /tmp/relay-scratch-2 && cd /tmp/relay-scratch-2 && git init -q -b main && echo hi > a.txt && git add . && git -c user.email=t@t -c user.name=t commit -qm init && claude -p "Reply with exactly the word: ready"`. It lands in `~/.claude/projects/-private-tmp-relay-scratch-2/`.
- [ ] **Step 2:** In the live file, `beforeAll` also copies the newest transcript of `RELAY_LIVE_2` (env, default `-private-tmp-relay-scratch-2`) when that directory exists; add a case gated on both sessions being listed:
```ts
  it('the orchestrator proposes a bulk run over both scratch sessions; confirmed rows answer; one summary comes back', async () => {
    const ids = engine.listSessions().map((s) => s.id);
    if (ids.length < 2) return; // second scratch session not set up
    events.length = 0;
    await engine.orchestratorSend(
      'Ask every session in repos relay-scratch and relay-scratch-2 to reply with exactly the word: bulked. Use one bulk action.',
    );
    await waitFor(() => engine.runState().bulkRuns.some((r) => r.status === 'proposed'), 180_000);
    const run = engine.runState().bulkRuns.find((r) => r.status === 'proposed')!;
    expect(run.rows).toHaveLength(2);
    engine.bulkConfirm(run.id, run.rows.map((r) => r.sessionId));
    await waitFor(() => engine.runState().bulkRuns.find((r) => r.id === run.id)?.status === 'finished', 300_000);
    const finished = engine.runState().bulkRuns.find((r) => r.id === run.id)!;
    expect(finished.rows.map((r) => r.status)).toEqual(['done', 'done']);
    await waitFor(
      () => events.some((e) => e.type === 'entry' && e.sessionId === ORCHESTRATOR_KEY && e.entry.origin === 'watch:bulk-end'),
      120_000,
    );
  }, 800_000);
```
Run `RELAY_LIVE=-private-tmp-relay-scratch pnpm --filter @relay/engine test live -t bulk` → PASS.
- [ ] **Step 3:** README: an "Bulk actions (M4)" paragraph — ask for many sessions at once; Relay shows a plan card; untick rows, then **Run on N sessions**; rows run three at a time; one summary at the end; destructive commands still wait in the approvals drawer.
- [ ] **Step 4:** Commit `docs: bulk actions; live check`.

---

## Follow-ups

- M5 PR watches: `list_prs` + watches feed bulk targets ("rebase every PR that is behind main").
- Bulk runs have no "retry failed rows" yet; the orchestrator can propose a new run over the failed ones.
