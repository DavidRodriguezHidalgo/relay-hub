# Relay Hub — Milestone 2: SessionRunner and approvals

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Relay can resume any listed session headless, send it instructions (steer / queue / interrupt), stream its output into the session panel, and hold destructive commands in an approvals queue the user decides on.

**Architecture:** `packages/engine` gains a `runner/` module (an `AgentClient` interface with an SDK-backed implementation, and a `SessionRunner` per driven session that owns one streaming `query()`), an `approvals/` module (pure rule classification plus an `ApprovalQueue` that turns `canUseTool` callbacks into pending decisions), and `RelayEngine` grows `send`, `interrupt`, `decide`, `runState` and a single `onEvent` stream. The desktop app forwards that stream over one IPC channel, and the session panel shows state, live entries, pending approvals and a dev-only send box; a global approvals drawer sits under the orchestrator placeholder.

**Tech Stack:** as M1 plus `@anthropic-ai/claude-agent-sdk` `^0.3.280` (Node ≥ 22.13; Electron 44 bundles Node 24).

**Spec:** `docs/superpowers/specs/2026-09-23-relay-hub-design.md` — sections "SessionRunner", "ApprovalQueue", "Message delivery modes", "Targeted instruction", "Error handling".

## Global Constraints

- `packages/engine` and `packages/shared` must not import from `electron` or `apps/desktop`. The SDK is imported only in `packages/engine/src/runner/sdk-agent-client.ts`; every other engine file talks to the `AgentClient` interface so tests use a scripted fake.
- Sessions run with `permissionMode: 'acceptEdits'`. The `canUseTool` callback therefore only sees what that mode does not auto-allow; Relay's rules decide what still waits for the user.
- Delivery modes (spec): `steer` = SDK `priority: 'now'` (default for the orchestrator and the dev box), `queue` = `priority: 'next'`, `interrupt` = `Query.interrupt()` then `priority: 'now'`.
- Origins: `user`, `orchestrator`, `watch:<event>`. Every message Relay sends carries one; every entry the panel shows from a Relay-driven turn carries the origin of the message that caused it.
- Session states: `idle | running | waiting-approval | error`. One runner per session id; a second `send` reuses it.
- A session is driven from Relay **or** from a terminal, never both. `RelayEngine.send` refuses (`SessionBusyError`) when Relay has no runner for the session and its transcript changed within the last 15 s — someone else is writing it.
- Approval decisions: `allow-once`, `deny`, `allow-pattern` (same tool + command head, for the life of that runner).
- Destructive git (always waits): `push --force`/`-f`/`+ref`, `reset --hard`, `clean`, `branch -D`, `rebase`, `commit --amend`, `filter-branch`, `filter-repo`, `rm -rf`. Any absolute path in a Bash command or a file tool's `file_path` outside the session cwd (and outside `/tmp`, `/private/tmp`) waits.
- No ticket ids in code or comments. Commits end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

## Review Focus

Inputs the spec implies that a person will hit, each pinned by a test in the owning task:

1. **A session still open in a terminal.** Sending to it from Relay would have two writers on one transcript. `send` must refuse with `SessionBusyError` while the file is being written by someone else (Task 7).
2. **An approval left pending, then an interrupt or process death.** The `canUseTool` promise must settle as deny, the pending item must disappear from the queue, and the runner must not hang in `waiting-approval` (Tasks 4 and 6).
3. **Resume of a broken session** (unknown id, corrupt transcript): the SDK yields an error result or throws. The runner must end in `error` with the reason, and a later `send` must be able to try again with a fresh run (Task 6).
4. **Two sends while a turn is running.** `steer` reaches the agent mid-turn, `queue` waits for the turn to end, and their order is preserved (Task 6).
5. **A chained shell command hiding a destructive step** (`git fetch && git reset --hard origin/main`, `git push -f`, `git push origin +main`). Rules must look at every command in the chain, not just the first token (Task 3).

---

### Task 1: Shared runner types and IPC contract

**Files:**
- Create: `packages/shared/src/runner.ts`
- Modify: `packages/shared/src/ipc.ts`, `packages/shared/src/index.ts`

**Interfaces:**
- Produces (used by every later task):
  ```ts
  type SessionState = 'idle' | 'running' | 'waiting-approval' | 'error';
  type DeliveryMode = 'steer' | 'queue' | 'interrupt';
  type MessageOrigin = 'user' | 'orchestrator' | `watch:${string}`;
  interface LiveEntry extends TranscriptEntry { origin: MessageOrigin | null }
  type ApprovalReason = 'destructive-git' | 'outside-cwd' | 'blocked-path';
  interface PendingApproval { id; sessionId; toolName; input; summary; reason; cwd; createdAt }
  type ApprovalDecision = { kind: 'allow-once' } | { kind: 'deny'; message?: string } | { kind: 'allow-pattern' }
  type RunnerEvent = state | entry | approval | approval-resolved
  interface RunState { states: Record<string, { state: SessionState; error: string | null }>; approvals: PendingApproval[] }
  ```

- [ ] **Step 1: Write the types**

`packages/shared/src/runner.ts`:
```ts
import type { TranscriptEntry } from './transcript';

export type SessionState = 'idle' | 'running' | 'waiting-approval' | 'error';

export type DeliveryMode = 'steer' | 'queue' | 'interrupt';

export type MessageOrigin = 'user' | 'orchestrator' | `watch:${string}`;

/** A transcript entry produced while Relay drives the session; `origin` names who caused the turn. */
export interface LiveEntry extends TranscriptEntry {
  origin: MessageOrigin | null;
}

export type ApprovalReason = 'destructive-git' | 'outside-cwd' | 'blocked-path';

export interface PendingApproval {
  id: string;
  sessionId: string;
  toolName: string;
  input: Record<string, unknown>;
  /** One line for the UI, e.g. the shell command or the file path. */
  summary: string;
  reason: ApprovalReason;
  cwd: string;
  createdAt: string;
}

export type ApprovalDecision =
  | { kind: 'allow-once' }
  | { kind: 'deny'; message?: string }
  /** Allow this tool + command head again without asking, for the life of the current runner. */
  | { kind: 'allow-pattern' };

export type RunnerEvent =
  | { type: 'state'; sessionId: string; state: SessionState; error: string | null }
  | { type: 'entry'; sessionId: string; entry: LiveEntry }
  | { type: 'approval'; approval: PendingApproval }
  | { type: 'approval-resolved'; approvalId: string; decision: ApprovalDecision['kind'] };

export interface RunState {
  states: Record<string, { state: SessionState; error: string | null }>;
  approvals: PendingApproval[];
}
```

In `packages/shared/src/ipc.ts` add the five channel names and the `SendRequest` type. **Leave `RelayApi` unchanged in this task** — its new members land in Task 8 together with the preload that implements them, so typecheck stays green in between.
```ts
import type { DeliveryMode, MessageOrigin } from './runner';

export const IPC = {
  listSessions: 'relay:listSessions',
  getTranscript: 'relay:getTranscript',
  sessionsChanged: 'relay:sessionsChanged',
  send: 'relay:send',
  interrupt: 'relay:interrupt',
  decide: 'relay:decide',
  runState: 'relay:runState',
  runnerEvent: 'relay:runnerEvent',
} as const;

export interface SendRequest {
  sessionId: string;
  prompt: string;
  mode: DeliveryMode;
  origin: MessageOrigin;
}
```
The full `RelayApi` after Task 8 will be:
```ts
export interface RelayApi {
  listSessions(): Promise<SessionSummary[]>;
  getTranscript(id: string): Promise<TranscriptEntry[]>;
  onSessionsChanged(listener: (sessions: SessionSummary[]) => void): () => void;
  send(request: SendRequest): Promise<string>;
  interrupt(sessionId: string): Promise<void>;
  decide(approvalId: string, decision: ApprovalDecision): Promise<void>;
  runState(): Promise<RunState>;
  onRunnerEvent(listener: (event: RunnerEvent) => void): () => void;
}
```

Append to `packages/shared/src/index.ts`:
```ts
export type {
  ApprovalDecision, ApprovalReason, DeliveryMode, LiveEntry, MessageOrigin, PendingApproval,
  RunnerEvent, RunState, SessionState,
} from './runner';
export type { SendRequest } from './ipc';
```

- [ ] **Step 2: Typecheck and commit**

Run: `cd ~/code/relay-hub && pnpm typecheck`
Expected: all three packages `Done` (nothing consumes the new types yet).

```bash
git add packages/shared
git commit -m "feat(shared): runner states, delivery modes, approvals and runner events"
```

---

### Task 2: AsyncQueue (pushable async iterable)

**Files:**
- Create: `packages/engine/src/runner/async-queue.ts`
- Test: `packages/engine/test/runner/async-queue.test.ts`

**Interfaces:**
- Produces: `class AsyncQueue<T> implements AsyncIterable<T> { push(item: T): void; end(): void; readonly size: number }`. Used as the SDK's streaming input.

- [ ] **Step 1: Failing test**

```ts
import { describe, expect, it } from 'vitest';
import { AsyncQueue } from '../../src/runner/async-queue';

async function drain<T>(q: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of q) out.push(x);
  return out;
}

describe('AsyncQueue', () => {
  it('yields pushed items in order and finishes on end()', async () => {
    const q = new AsyncQueue<number>();
    q.push(1);
    q.push(2);
    const done = drain(q);
    q.push(3);
    q.end();
    expect(await done).toEqual([1, 2, 3]);
  });

  it('waits for an item pushed later', async () => {
    const q = new AsyncQueue<string>();
    const it = q[Symbol.asyncIterator]();
    const next = it.next();
    setTimeout(() => q.push('late'), 10);
    expect(await next).toEqual({ value: 'late', done: false });
    q.end();
    expect(await it.next()).toEqual({ value: undefined, done: true });
  });

  it('ignores pushes after end and reports size', () => {
    const q = new AsyncQueue<number>();
    q.push(1);
    expect(q.size).toBe(1);
    q.end();
    q.push(2);
    expect(q.size).toBe(1);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @relay/engine test async-queue`
Expected: FAIL, module not found.

- [ ] **Step 3: Implementation**

```ts
/** Minimal pushable async iterable: producers `push`, one consumer iterates, `end` closes. */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly items: T[] = [];
  private waiter: ((r: IteratorResult<T>) => void) | null = null;
  private ended = false;

  get size(): number {
    return this.items.length;
  }

  push(item: T): void {
    if (this.ended) return;
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w({ value: item, done: false });
    } else {
      this.items.push(item);
    }
  }

  end(): void {
    this.ended = true;
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const item = this.items.shift();
        if (item !== undefined) return Promise.resolve({ value: item, done: false });
        if (this.ended) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => {
          this.waiter = resolve;
        });
      },
    };
  }
}
```

- [ ] **Step 4: Run to verify pass, commit**

Run: `pnpm --filter @relay/engine test async-queue` → PASS.

```bash
git add packages/engine
git commit -m "feat(engine): AsyncQueue for streaming agent input"
```

---

### Task 3: Approval rules (pure classification)

**Files:**
- Create: `packages/engine/src/approvals/rules.ts`
- Test: `packages/engine/test/approvals/rules.test.ts`

**Interfaces:**
- Produces:
  ```ts
  type Verdict = { outcome: 'allow' } | { outcome: 'ask'; reason: ApprovalReason; summary: string };
  function classifyToolUse(toolName: string, input: Record<string, unknown>, cwd: string, blockedPath?: string): Verdict;
  function patternKey(toolName: string, input: Record<string, unknown>): string;  // 'Bash git push' / 'Edit'
  ```

Rules: Bash → split the command on `&&`, `||`, `;`, `|`, newline, then on whitespace into tokens per segment. Destructive git if a segment's tokens start with `git` (after optional `sudo`/`env` prefix skipping is **not** attempted; YAGNI) and match the table. `rm` with a flag containing both `r` and `f` is destructive. Any token that is an absolute path (starts with `/`) and is not under `cwd`, `/tmp`, `/private/tmp` → outside-cwd. File tools (`Edit`, `Write`, `Read`, `MultiEdit`, `NotebookEdit`) with `file_path`/`path`/`notebook_path` outside cwd → outside-cwd. `blockedPath` present → `blocked-path`. Everything else → allow.

- [ ] **Step 1: Failing tests**

```ts
import { describe, expect, it } from 'vitest';
import { classifyToolUse, patternKey } from '../../src/approvals/rules';

const cwd = '/Users/me/code/repo';
const bash = (command: string) => classifyToolUse('Bash', { command }, cwd);

describe('classifyToolUse', () => {
  it.each([
    'git push --force origin feat',
    'git push -f',
    'git push origin +main',
    'git reset --hard HEAD~1',
    'git clean -fd',
    'git branch -D old',
    'git rebase main',
    'git commit --amend --no-edit',
    'git filter-repo --path x',
    'rm -rf dist',
    'rm -fr dist',
    'git fetch && git reset --hard origin/main',
    'pnpm build; git push --force-with-lease',
  ])('asks for destructive git / rm: %s', (command) => {
    expect(bash(command)).toMatchObject({ outcome: 'ask', reason: 'destructive-git', summary: command });
  });

  it.each([
    'git status',
    'git push origin feat',
    'git commit -m "x"',
    'git rebase --continue',
    'git branch -d merged',
    'rm dist/out.js',
    'pnpm test',
    `cat ${cwd}/README.md`,
    'ls /tmp/x && cat /private/tmp/y',
  ])('allows ordinary commands: %s', (command) => {
    expect(bash(command)).toEqual({ outcome: 'allow' });
  });

  it('asks when a Bash command touches a path outside the cwd', () => {
    expect(bash('cat /Users/me/code/other/secret.env')).toMatchObject({ outcome: 'ask', reason: 'outside-cwd' });
    expect(bash(`cp ${cwd}/a /Users/me/Desktop/a`)).toMatchObject({ outcome: 'ask', reason: 'outside-cwd' });
  });

  it('asks when a file tool targets a path outside the cwd, allows inside', () => {
    expect(classifyToolUse('Edit', { file_path: '/Users/me/code/other/x.ts' }, cwd)).toMatchObject({
      outcome: 'ask', reason: 'outside-cwd', summary: '/Users/me/code/other/x.ts',
    });
    expect(classifyToolUse('Write', { file_path: `${cwd}/src/x.ts` }, cwd)).toEqual({ outcome: 'allow' });
    expect(classifyToolUse('Read', { file_path: '/tmp/scratch.txt' }, cwd)).toEqual({ outcome: 'allow' });
  });

  it('asks when the SDK reports a blocked path', () => {
    expect(classifyToolUse('Bash', { command: 'ls' }, cwd, '/etc/hosts')).toMatchObject({
      outcome: 'ask', reason: 'blocked-path', summary: '/etc/hosts',
    });
  });

  it('allows unknown tools', () => {
    expect(classifyToolUse('WebFetch', { url: 'https://x' }, cwd)).toEqual({ outcome: 'allow' });
  });
});

describe('patternKey', () => {
  it('is tool + first two command words for Bash, tool name otherwise', () => {
    expect(patternKey('Bash', { command: 'git push --force origin x' })).toBe('Bash git push');
    expect(patternKey('Bash', { command: 'rm -rf dist' })).toBe('Bash rm -rf');
    expect(patternKey('Edit', { file_path: '/x' })).toBe('Edit');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @relay/engine test approvals/rules` → FAIL, module not found.

- [ ] **Step 3: Implementation**

```ts
import { isAbsolute, relative } from 'node:path';
import type { ApprovalReason } from '@relay/shared';

export type Verdict = { outcome: 'allow' } | { outcome: 'ask'; reason: ApprovalReason; summary: string };

const FILE_TOOLS = new Set(['Edit', 'Write', 'Read', 'MultiEdit', 'NotebookEdit']);
const PATH_KEYS = ['file_path', 'path', 'notebook_path'];
const SAFE_ROOTS = ['/tmp', '/private/tmp'];

function segments(command: string): string[][] {
  return command
    .split(/&&|\|\||;|\||\n/)
    .map((s) => s.trim().split(/\s+/).filter(Boolean))
    .filter((t) => t.length > 0);
}

function isUnder(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function outsideCwd(path: string, cwd: string): boolean {
  return isAbsolute(path) && !isUnder(path, cwd) && !SAFE_ROOTS.some((r) => isUnder(path, r));
}

function destructiveGit(tokens: string[]): boolean {
  const [cmd, sub, ...rest] = tokens;
  if (cmd === 'rm') return tokens.slice(1).some((t) => /^-[a-zA-Z]*r[a-zA-Z]*f|^-[a-zA-Z]*f[a-zA-Z]*r/.test(t));
  if (cmd !== 'git') return false;
  switch (sub) {
    case 'push':
      return rest.some((t) => t === '--force' || t === '-f' || t.startsWith('--force-with-lease') || t.startsWith('+'));
    case 'reset':
      return rest.includes('--hard');
    case 'clean':
    case 'filter-branch':
    case 'filter-repo':
      return true;
    case 'branch':
      return rest.includes('-D');
    case 'rebase':
      return !rest.some((t) => t === '--continue' || t === '--abort' || t === '--skip');
    case 'commit':
      return rest.includes('--amend');
    default:
      return false;
  }
}

/** Decides whether a tool call may run under accept-edits or must wait for the user. */
export function classifyToolUse(
  toolName: string,
  input: Record<string, unknown>,
  cwd: string,
  blockedPath?: string,
): Verdict {
  if (blockedPath) return { outcome: 'ask', reason: 'blocked-path', summary: blockedPath };

  if (toolName === 'Bash' && typeof input.command === 'string') {
    const command = input.command;
    const segs = segments(command);
    if (segs.some(destructiveGit)) return { outcome: 'ask', reason: 'destructive-git', summary: command };
    const outside = segs.flat().find((t) => outsideCwd(t, cwd));
    if (outside) return { outcome: 'ask', reason: 'outside-cwd', summary: command };
    return { outcome: 'allow' };
  }

  if (FILE_TOOLS.has(toolName)) {
    for (const key of PATH_KEYS) {
      const p = input[key];
      if (typeof p === 'string' && outsideCwd(p, cwd)) return { outcome: 'ask', reason: 'outside-cwd', summary: p };
    }
  }
  return { outcome: 'allow' };
}

/** Key for "allow this kind again": tool plus the first two words of a shell command. */
export function patternKey(toolName: string, input: Record<string, unknown>): string {
  if (toolName === 'Bash' && typeof input.command === 'string') {
    const head = input.command.trim().split(/\s+/).slice(0, 2).join(' ');
    return `${toolName} ${head}`;
  }
  return toolName;
}
```

Note on the `rm` regex: it's a flag-shape check (`-rf`, `-fr`, `-Rf`…), not agent-behaviour routing; fine here.

- [ ] **Step 4: Run to verify pass, commit**

Run: `pnpm --filter @relay/engine test approvals/rules` → PASS (all `it.each` rows).

```bash
git add packages/engine
git commit -m "feat(engine): approval rules for destructive git and out-of-cwd paths"
```

---

### Task 4: ApprovalQueue

**Files:**
- Create: `packages/engine/src/approvals/approval-queue.ts`
- Test: `packages/engine/test/approvals/approval-queue.test.ts`

**Interfaces:**
- Consumes: `classifyToolUse`, `patternKey` (Task 3); `PendingApproval`, `ApprovalDecision` (Task 1).
- Produces:
  ```ts
  type PermissionOutcome = { behavior: 'allow' } | { behavior: 'deny'; message: string };
  class ApprovalQueue extends EventEmitter<{ pending: [PendingApproval]; resolved: [string, ApprovalDecision['kind']] }> {
    request(req: { sessionId; toolName; input; cwd; blockedPath?; signal: AbortSignal }): Promise<PermissionOutcome>
    decide(approvalId: string, decision: ApprovalDecision): void   // throws on unknown id
    pending(): PendingApproval[]
    cancelSession(sessionId: string, message: string): void        // denies all pending for that session
    forgetSession(sessionId: string): void                          // drops its allow-patterns
  }
  ```

- [ ] **Step 1: Failing tests**

```ts
import { describe, expect, it } from 'vitest';
import { ApprovalQueue } from '../../src/approvals/approval-queue';

const cwd = '/repo';
const req = (q: ApprovalQueue, command: string, signal = new AbortController().signal) =>
  q.request({ sessionId: 's1', toolName: 'Bash', input: { command }, cwd, signal });

describe('ApprovalQueue', () => {
  it('allows safe calls immediately without emitting', async () => {
    const q = new ApprovalQueue();
    const events: unknown[] = [];
    q.on('pending', (p) => events.push(p));
    expect(await req(q, 'pnpm test')).toEqual({ behavior: 'allow' });
    expect(events).toEqual([]);
    expect(q.pending()).toEqual([]);
  });

  it('holds a destructive call until decided, then allows once', async () => {
    const q = new ApprovalQueue();
    const pendingEvents: string[] = [];
    q.on('pending', (p) => pendingEvents.push(p.id));
    const outcome = req(q, 'git push --force');
    const [p] = q.pending();
    expect(p).toMatchObject({ sessionId: 's1', toolName: 'Bash', reason: 'destructive-git', summary: 'git push --force' });
    expect(pendingEvents).toEqual([p!.id]);
    q.decide(p!.id, { kind: 'allow-once' });
    expect(await outcome).toEqual({ behavior: 'allow' });
    expect(q.pending()).toEqual([]);
    // the same command asks again
    void req(q, 'git push --force');
    expect(q.pending()).toHaveLength(1);
  });

  it('deny returns a message the agent sees', async () => {
    const q = new ApprovalQueue();
    const outcome = req(q, 'git reset --hard');
    q.decide(q.pending()[0]!.id, { kind: 'deny', message: 'not on this branch' });
    expect(await outcome).toEqual({ behavior: 'deny', message: 'not on this branch' });
  });

  it('allow-pattern skips the prompt for the same tool + command head in that session only', async () => {
    const q = new ApprovalQueue();
    const first = req(q, 'git push --force origin a');
    q.decide(q.pending()[0]!.id, { kind: 'allow-pattern' });
    expect(await first).toEqual({ behavior: 'allow' });
    expect(await req(q, 'git push -f origin b')).toEqual({ behavior: 'allow' });
    // a different session still asks
    void q.request({ sessionId: 's2', toolName: 'Bash', input: { command: 'git push -f' }, cwd, signal: new AbortController().signal });
    expect(q.pending().map((p) => p.sessionId)).toEqual(['s2']);
    // and after forgetSession, s1 asks again
    q.forgetSession('s1');
    void req(q, 'git push -f origin c');
    expect(q.pending().map((p) => p.sessionId)).toEqual(['s2', 's1']);
  });

  it('cancelSession denies every pending item of that session', async () => {
    const q = new ApprovalQueue();
    const resolved: string[] = [];
    q.on('resolved', (id, kind) => resolved.push(`${id}:${kind}`));
    const a = req(q, 'git clean -fd');
    const b = req(q, 'git rebase main');
    const ids = q.pending().map((p) => p.id);
    q.cancelSession('s1', 'session interrupted');
    expect(await a).toEqual({ behavior: 'deny', message: 'session interrupted' });
    expect(await b).toEqual({ behavior: 'deny', message: 'session interrupted' });
    expect(q.pending()).toEqual([]);
    expect(resolved).toEqual(ids.map((id) => `${id}:deny`));
  });

  it('an aborted signal denies and removes the item', async () => {
    const q = new ApprovalQueue();
    const ac = new AbortController();
    const outcome = req(q, 'git clean -fd', ac.signal);
    ac.abort();
    expect(await outcome).toEqual({ behavior: 'deny', message: 'aborted' });
    expect(q.pending()).toEqual([]);
  });

  it('decide throws for an unknown id', () => {
    expect(() => new ApprovalQueue().decide('nope', { kind: 'allow-once' })).toThrow(/unknown approval/i);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @relay/engine test approval-queue` → FAIL, module not found.

- [ ] **Step 3: Implementation**

```ts
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { ApprovalDecision, PendingApproval } from '@relay/shared';
import { classifyToolUse, patternKey } from './rules';

export type PermissionOutcome = { behavior: 'allow' } | { behavior: 'deny'; message: string };

export interface ApprovalRequest {
  sessionId: string;
  toolName: string;
  input: Record<string, unknown>;
  cwd: string;
  blockedPath?: string;
  signal: AbortSignal;
}

type Waiting = { approval: PendingApproval; resolve: (o: PermissionOutcome) => void; onAbort: () => void };

type QueueEvents = { pending: [PendingApproval]; resolved: [string, ApprovalDecision['kind']] };

/** Turns `canUseTool` callbacks into pending decisions; safe calls pass straight through. */
export class ApprovalQueue extends EventEmitter<QueueEvents> {
  private readonly waiting = new Map<string, Waiting>();
  private readonly allowed = new Map<string, Set<string>>();

  request(req: ApprovalRequest): Promise<PermissionOutcome> {
    const verdict = classifyToolUse(req.toolName, req.input, req.cwd, req.blockedPath);
    if (verdict.outcome === 'allow') return Promise.resolve({ behavior: 'allow' });
    if (this.allowed.get(req.sessionId)?.has(patternKey(req.toolName, req.input))) {
      return Promise.resolve({ behavior: 'allow' });
    }
    const approval: PendingApproval = {
      id: randomUUID(),
      sessionId: req.sessionId,
      toolName: req.toolName,
      input: req.input,
      summary: verdict.summary,
      reason: verdict.reason,
      cwd: req.cwd,
      createdAt: new Date().toISOString(),
    };
    return new Promise((resolve) => {
      const onAbort = () => this.settle(approval.id, { behavior: 'deny', message: 'aborted' }, 'deny');
      req.signal.addEventListener('abort', onAbort, { once: true });
      this.waiting.set(approval.id, { approval, resolve, onAbort });
      this.emit('pending', approval);
    });
  }

  decide(approvalId: string, decision: ApprovalDecision): void {
    const w = this.waiting.get(approvalId);
    if (!w) throw new Error(`Unknown approval ${approvalId}`);
    switch (decision.kind) {
      case 'allow-once':
        this.settle(approvalId, { behavior: 'allow' }, 'allow-once');
        break;
      case 'allow-pattern': {
        const set = this.allowed.get(w.approval.sessionId) ?? new Set<string>();
        set.add(patternKey(w.approval.toolName, w.approval.input));
        this.allowed.set(w.approval.sessionId, set);
        this.settle(approvalId, { behavior: 'allow' }, 'allow-pattern');
        break;
      }
      case 'deny':
        this.settle(approvalId, { behavior: 'deny', message: decision.message ?? 'denied by user' }, 'deny');
        break;
    }
  }

  pending(): PendingApproval[] {
    return [...this.waiting.values()].map((w) => w.approval);
  }

  cancelSession(sessionId: string, message: string): void {
    for (const [id, w] of this.waiting) {
      if (w.approval.sessionId === sessionId) this.settle(id, { behavior: 'deny', message }, 'deny');
    }
  }

  forgetSession(sessionId: string): void {
    this.allowed.delete(sessionId);
  }

  private settle(id: string, outcome: PermissionOutcome, kind: ApprovalDecision['kind']): void {
    const w = this.waiting.get(id);
    if (!w) return;
    this.waiting.delete(id);
    w.resolve(outcome);
    this.emit('resolved', id, kind);
  }
}
```

- [ ] **Step 4: Run to verify pass, commit**

Run: `pnpm --filter @relay/engine test approval` → PASS.

```bash
git add packages/engine
git commit -m "feat(engine): ApprovalQueue holding destructive tool calls for a decision"
```

---

### Task 5: AgentClient interface and SDK implementation

**Files:**
- Create: `packages/engine/src/runner/agent-client.ts`, `packages/engine/src/runner/sdk-agent-client.ts`
- Modify: `packages/engine/src/transcript/parse-transcript.ts` (export `blocksFromContent`), `packages/engine/package.json`
- Test: `packages/engine/test/runner/sdk-agent-client.test.ts`

**Interfaces:**
- Produces:
  ```ts
  interface AgentInput { text: string; priority: 'now' | 'next'; origin: MessageOrigin }
  type AgentMessage =
    | { type: 'init'; sessionId: string }
    | { type: 'assistant'; uuid: string; timestamp: string; blocks: TranscriptBlock[] }
    | { type: 'tool-results'; uuid: string; timestamp: string; blocks: TranscriptBlock[] }
    | { type: 'result'; isError: boolean; error: string | null }
  interface AgentRun { messages: AsyncIterable<AgentMessage>; interrupt(): Promise<void> }
  interface AgentClient {
    start(opts: { sessionId: string; cwd: string; input: AsyncIterable<AgentInput>;
                  canUseTool: (toolName, input, blockedPath?, signal) => Promise<PermissionOutcome> }): AgentRun
  }
  class SdkAgentClient implements AgentClient
  ```
  Everything downstream depends only on `AgentClient`; the SDK types stay inside `sdk-agent-client.ts`.

- [ ] **Step 1: Add the SDK and export the block mapper**

```bash
pnpm --filter @relay/engine add @anthropic-ai/claude-agent-sdk@^0.3.280
```
(If pnpm's release-age policy rejects the newest patch, pin the newest one it accepts — check with `npm view @anthropic-ai/claude-agent-sdk time --json`.)

In `parse-transcript.ts` rename the module-private `toBlocks` to an exported `blocksFromContent`, widen its parameter to `content: unknown` (the body already guards with `typeof content === 'string'` and `Array.isArray`; type the array elements as `RawBlock` inside the loop with `for (const b of content as RawBlock[])`), and update its two call sites. Add to `src/index.ts`: `export { blocksFromContent } from './transcript/parse-transcript';`.

- [ ] **Step 2: Failing test** — the SDK client is tested by injecting a fake `query` function, so no network:

```ts
import { describe, expect, it } from 'vitest';
import { SdkAgentClient, type SdkQueryFn } from '../../src/runner/sdk-agent-client';
import { AsyncQueue } from '../../src/runner/async-queue';
import type { AgentInput } from '../../src/runner/agent-client';

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

describe('SdkAgentClient', () => {
  it('passes resume, cwd, acceptEdits and a canUseTool bridge to query(), and maps messages', async () => {
    let seen: Parameters<SdkQueryFn>[0] | null = null;
    let interrupted = false;
    const fakeQuery: SdkQueryFn = (params) => {
      seen = params;
      async function* gen() {
        yield { type: 'system', subtype: 'init', session_id: 'abc', cwd: '/r', model: 'm', permissionMode: 'acceptEdits' };
        yield {
          type: 'assistant', uuid: 'a1', session_id: 'abc', parent_tool_use_id: null,
          message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }, { type: 'tool_use', id: 't', name: 'Bash', input: { command: 'ls' } }] },
        };
        yield {
          type: 'user', uuid: 'u1', session_id: 'abc', parent_tool_use_id: null,
          message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }] },
        };
        yield { type: 'result', subtype: 'success', is_error: false, session_id: 'abc', result: 'done' };
      }
      const g = gen() as AsyncGenerator<unknown, void> & { interrupt: () => Promise<void> };
      g.interrupt = async () => { interrupted = true; };
      return g;
    };
    const client = new SdkAgentClient(fakeQuery);
    const input = new AsyncQueue<AgentInput>();
    const run = client.start({
      sessionId: 'abc', cwd: '/r', input,
      canUseTool: async () => ({ behavior: 'allow' }),
    });
    const msgs = await collect(run.messages);
    await run.interrupt();

    expect(seen!.options).toMatchObject({ resume: 'abc', cwd: '/r', permissionMode: 'acceptEdits' });
    expect(typeof seen!.options!.canUseTool).toBe('function');
    expect(msgs).toEqual([
      { type: 'init', sessionId: 'abc' },
      { type: 'assistant', uuid: 'a1', timestamp: expect.any(String), blocks: [
        { kind: 'text', text: 'hi' }, { kind: 'tool_use', id: 't', name: 'Bash', input: { command: 'ls' } },
      ] },
      { type: 'tool-results', uuid: 'u1', timestamp: expect.any(String), blocks: [
        { kind: 'tool_result', toolUseId: 't', text: 'ok', isError: false },
      ] },
      { type: 'result', isError: false, error: null },
    ]);
    expect(interrupted).toBe(true);
  });

  it('turns AgentInput into SDK user messages with priority and a human origin', async () => {
    let received: unknown[] = [];
    const fakeQuery: SdkQueryFn = (params) => {
      async function* gen() {
        for await (const m of params.prompt as AsyncIterable<unknown>) received.push(m);
      }
      const g = gen() as AsyncGenerator<unknown, void> & { interrupt: () => Promise<void> };
      g.interrupt = async () => undefined;
      return g;
    };
    const input = new AsyncQueue<AgentInput>();
    input.push({ text: 'do x', priority: 'now', origin: 'orchestrator' });
    input.push({ text: 'then y', priority: 'next', origin: 'watch:ci_failed' });
    input.end();
    const run = new SdkAgentClient(fakeQuery).start({ sessionId: 's', cwd: '/r', input, canUseTool: async () => ({ behavior: 'allow' }) });
    await collect(run.messages);
    expect(received).toEqual([
      { type: 'user', message: { role: 'user', content: 'do x' }, parent_tool_use_id: null, priority: 'now', origin: { kind: 'human' } },
      { type: 'user', message: { role: 'user', content: 'then y' }, parent_tool_use_id: null, priority: 'next', origin: { kind: 'human' } },
    ]);
  });

  it('maps an error result and a deny from canUseTool', async () => {
    let bridged: unknown = null;
    const fakeQuery: SdkQueryFn = (params) => {
      async function* gen() {
        bridged = await params.options!.canUseTool!('Bash', { command: 'git push -f' }, { signal: new AbortController().signal });
        yield { type: 'result', subtype: 'error_during_execution', is_error: true, session_id: 's', errors: ['boom'] };
      }
      const g = gen() as AsyncGenerator<unknown, void> & { interrupt: () => Promise<void> };
      g.interrupt = async () => undefined;
      return g;
    };
    const run = new SdkAgentClient(fakeQuery).start({
      sessionId: 's', cwd: '/r', input: new AsyncQueue(),
      canUseTool: async () => ({ behavior: 'deny', message: 'no' }),
    });
    const msgs = await collect(run.messages);
    expect(bridged).toEqual({ behavior: 'deny', message: 'no' });
    expect(msgs).toEqual([{ type: 'result', isError: true, error: 'error_during_execution: boom' }]);
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `pnpm --filter @relay/engine test sdk-agent-client` → FAIL, module not found.

- [ ] **Step 4: Implementation**

`packages/engine/src/runner/agent-client.ts`:
```ts
import type { MessageOrigin, TranscriptBlock } from '@relay/shared';
import type { PermissionOutcome } from '../approvals/approval-queue';

export interface AgentInput {
  text: string;
  /** `now` reaches a running turn (steer); `next` waits for the turn to end (queue). */
  priority: 'now' | 'next';
  origin: MessageOrigin;
}

export type AgentMessage =
  | { type: 'init'; sessionId: string }
  | { type: 'assistant'; uuid: string; timestamp: string; blocks: TranscriptBlock[] }
  | { type: 'tool-results'; uuid: string; timestamp: string; blocks: TranscriptBlock[] }
  | { type: 'result'; isError: boolean; error: string | null };

export interface AgentRun {
  messages: AsyncIterable<AgentMessage>;
  interrupt(): Promise<void>;
}

export type CanUseToolFn = (
  toolName: string,
  input: Record<string, unknown>,
  blockedPath: string | undefined,
  signal: AbortSignal,
) => Promise<PermissionOutcome>;

export interface AgentStartOptions {
  sessionId: string;
  cwd: string;
  input: AsyncIterable<AgentInput>;
  canUseTool: CanUseToolFn;
}

/** The only seam between Relay and the agent runtime; tests script it, production uses the SDK. */
export interface AgentClient {
  start(opts: AgentStartOptions): AgentRun;
}
```

`packages/engine/src/runner/sdk-agent-client.ts`:
```ts
import { query as sdkQuery, type Options, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { blocksFromContent } from '../transcript/parse-transcript';
import type { AgentClient, AgentInput, AgentMessage, AgentRun, AgentStartOptions } from './agent-client';

/** The shape of `query` we depend on, so tests can inject a fake. */
export type SdkQueryFn = (params: { prompt: string | AsyncIterable<SDKUserMessage>; options?: Options }) =>
  AsyncGenerator<SDKMessage, void> & { interrupt(): Promise<unknown> };

async function* toSdkInput(input: AsyncIterable<AgentInput>): AsyncIterable<SDKUserMessage> {
  for await (const m of input) {
    yield {
      type: 'user',
      message: { role: 'user', content: m.text },
      parent_tool_use_id: null,
      priority: m.priority,
      origin: { kind: 'human' },
    };
  }
}

function mapMessage(m: SDKMessage): AgentMessage | null {
  const now = new Date().toISOString();
  switch (m.type) {
    case 'system':
      return m.subtype === 'init' ? { type: 'init', sessionId: m.session_id } : null;
    case 'assistant':
      return { type: 'assistant', uuid: m.uuid, timestamp: now, blocks: blocksFromContent(m.message.content) };
    case 'user': {
      const content = m.message.content;
      if (typeof content === 'string') return null; // our own prompt echoed back
      const uuid = 'uuid' in m && typeof m.uuid === 'string' ? m.uuid : `${now}-tool-results`;
      return { type: 'tool-results', uuid, timestamp: now, blocks: blocksFromContent(content) };
    }
    case 'result': {
      if (m.subtype === 'success') return { type: 'result', isError: m.is_error, error: m.is_error ? m.result : null };
      const errors = 'errors' in m && Array.isArray(m.errors) ? m.errors.join('; ') : '';
      return { type: 'result', isError: true, error: errors ? `${m.subtype}: ${errors}` : m.subtype };
    }
    default:
      return null;
  }
}

/** Drives one Claude Code session through the Agent SDK in streaming-input mode. */
export class SdkAgentClient implements AgentClient {
  constructor(private readonly queryFn: SdkQueryFn = sdkQuery as unknown as SdkQueryFn) {}

  start(opts: AgentStartOptions): AgentRun {
    const q = this.queryFn({
      prompt: toSdkInput(opts.input),
      options: {
        resume: opts.sessionId,
        cwd: opts.cwd,
        permissionMode: 'acceptEdits',
        canUseTool: (toolName, input, { signal, blockedPath }) =>
          opts.canUseTool(toolName, input, blockedPath, signal).then((o) =>
            o.behavior === 'allow' ? { behavior: 'allow' as const } : { behavior: 'deny' as const, message: o.message },
          ),
      },
    });
    async function* messages(): AsyncIterable<AgentMessage> {
      for await (const m of q) {
        const mapped = mapMessage(m);
        if (mapped) yield mapped;
      }
    }
    return { messages: messages(), interrupt: () => q.interrupt().then(() => undefined) };
  }
}
```
Add to `src/index.ts`:
```ts
export { SdkAgentClient } from './runner/sdk-agent-client';
export type { AgentClient, AgentInput, AgentMessage, AgentRun, AgentStartOptions, CanUseToolFn } from './runner/agent-client';
```

- [ ] **Step 5: Run to verify pass, typecheck, commit**

Run: `pnpm --filter @relay/engine test sdk-agent-client && pnpm typecheck` → PASS / Done.

```bash
git add packages/engine
git commit -m "feat(engine): AgentClient seam and SDK implementation in streaming-input mode"
```

---

### Task 6: SessionRunner

**Files:**
- Create: `packages/engine/src/runner/session-runner.ts`
- Test: `packages/engine/test/runner/session-runner.test.ts`, `packages/engine/test/runner/fake-agent-client.ts`

**Interfaces:**
- Consumes: `AgentClient`, `AgentInput`, `AgentMessage` (Task 5); `ApprovalQueue` (Task 4); `AsyncQueue` (Task 2).
- Produces:
  ```ts
  type RunnerEvents = { state: [SessionState, string | null]; entry: [LiveEntry]; }
  class SessionRunner extends EventEmitter<RunnerEvents> {
    constructor(opts: { sessionId: string; cwd: string; client: AgentClient; approvals: ApprovalQueue })
    readonly sessionId: string
    get state(): SessionState
    get error(): string | null
    send(prompt: string, opts: { mode: DeliveryMode; origin: MessageOrigin }): Promise<string>  // messageId
    interrupt(): Promise<void>
    close(): Promise<void>
  }
  ```
  Behaviour: the first `send` starts the run (lazy). `steer` → `priority 'now'`; `queue` → `'next'`; `interrupt` → `run.interrupt()` then `'now'`. State: `running` from a send until a `result` arrives with nothing else outstanding; `waiting-approval` while the approvals queue holds an item for this session (back to `running` when it settles); `error` when the run throws or a result is an error — the run is dropped, a later `send` starts a fresh one. `close()` ends input, cancels pending approvals, waits for the run to finish.

- [ ] **Step 1: The scripted fake**

`packages/engine/test/runner/fake-agent-client.ts`:
```ts
import { AsyncQueue } from '../../src/runner/async-queue';
import type { AgentClient, AgentInput, AgentMessage, AgentRun, AgentStartOptions } from '../../src/runner/agent-client';

/** A hand-driven agent: the test pushes messages, reads what was sent, and can fail the run. */
export class FakeAgentClient implements AgentClient {
  starts: AgentStartOptions[] = [];
  received: AgentInput[] = [];
  out = new AsyncQueue<AgentMessage>();
  interrupts = 0;
  failWith: Error | null = null;
  lastOpts: AgentStartOptions | null = null;

  start(opts: AgentStartOptions): AgentRun {
    this.starts.push(opts);
    this.lastOpts = opts;
    this.out = new AsyncQueue<AgentMessage>();
    void (async () => {
      for await (const m of opts.input) this.received.push(m);
    })();
    const self = this;
    async function* messages() {
      for await (const m of self.out) {
        if (self.failWith) throw self.failWith;
        yield m;
      }
    }
    return { messages: messages(), interrupt: async () => { self.interrupts += 1; } };
  }

  /** Simulates the agent asking permission; resolves with the queue's decision. */
  askTool(toolName: string, input: Record<string, unknown>) {
    return this.lastOpts!.canUseTool(toolName, input, undefined, new AbortController().signal);
  }

  assistant(uuid: string, text: string) {
    this.out.push({ type: 'assistant', uuid, timestamp: '2026-09-23T00:00:00.000Z', blocks: [{ kind: 'text', text }] });
  }

  result(error: string | null = null) {
    this.out.push({ type: 'result', isError: error !== null, error });
  }

  die(err: Error) {
    this.failWith = err;
    this.out.push({ type: 'result', isError: false, error: null }); // wake the consumer
  }
}

export const tick = () => new Promise((r) => setTimeout(r, 0));
```

- [ ] **Step 2: Failing tests**

```ts
import { describe, expect, it } from 'vitest';
import type { LiveEntry, SessionState } from '@relay/shared';
import { ApprovalQueue } from '../../src/approvals/approval-queue';
import { SessionRunner } from '../../src/runner/session-runner';
import { FakeAgentClient, tick } from './fake-agent-client';

function setup() {
  const client = new FakeAgentClient();
  const approvals = new ApprovalQueue();
  const runner = new SessionRunner({ sessionId: 's1', cwd: '/repo', client, approvals });
  const states: SessionState[] = [];
  const entries: LiveEntry[] = [];
  runner.on('state', (s) => states.push(s));
  runner.on('entry', (e) => entries.push(e));
  return { client, approvals, runner, states, entries };
}

describe('SessionRunner', () => {
  it('starts lazily on the first send and reports entries with the origin, then idles on result', async () => {
    const { client, runner, states, entries } = setup();
    expect(runner.state).toBe('idle');
    expect(client.starts).toHaveLength(0);
    const id = await runner.send('do x', { mode: 'steer', origin: 'orchestrator' });
    expect(id).toMatch(/.+/);
    await tick();
    expect(client.starts[0]).toMatchObject({ sessionId: 's1', cwd: '/repo' });
    expect(client.received).toEqual([{ text: 'do x', priority: 'now', origin: 'orchestrator' }]);
    expect(runner.state).toBe('running');
    client.assistant('a1', 'working');
    client.result();
    await tick();
    expect(entries).toEqual([expect.objectContaining({ uuid: 'a1', role: 'assistant', origin: 'orchestrator' })]);
    expect(runner.state).toBe('idle');
    expect(states).toEqual(['running', 'idle']);
  });

  it('steer goes now, queue goes next, interrupt calls interrupt() first — order preserved', async () => {
    const { client, runner } = setup();
    await runner.send('a', { mode: 'steer', origin: 'user' });
    await runner.send('b', { mode: 'queue', origin: 'watch:ci_failed' });
    await runner.send('c', { mode: 'interrupt', origin: 'user' });
    await tick();
    expect(client.interrupts).toBe(1);
    expect(client.received.map((m) => [m.text, m.priority])).toEqual([['a', 'now'], ['b', 'next'], ['c', 'now']]);
  });

  it('a second send while running reuses the same run', async () => {
    const { client, runner } = setup();
    await runner.send('a', { mode: 'steer', origin: 'user' });
    await runner.send('b', { mode: 'steer', origin: 'user' });
    expect(client.starts).toHaveLength(1);
  });

  it('goes to waiting-approval while a destructive call is pending and back to running when decided', async () => {
    const { client, approvals, runner, states } = setup();
    await runner.send('push it', { mode: 'steer', origin: 'user' });
    await tick();
    const outcome = client.askTool('Bash', { command: 'git push --force' });
    await tick();
    expect(runner.state).toBe('waiting-approval');
    approvals.decide(approvals.pending()[0]!.id, { kind: 'allow-once' });
    expect(await outcome).toEqual({ behavior: 'allow' });
    await tick();
    expect(runner.state).toBe('running');
    expect(states).toEqual(['running', 'waiting-approval', 'running']);
  });

  it('interrupt denies pending approvals so the agent never hangs', async () => {
    const { client, approvals, runner } = setup();
    await runner.send('x', { mode: 'steer', origin: 'user' });
    await tick();
    const outcome = client.askTool('Bash', { command: 'git reset --hard' });
    await tick();
    await runner.interrupt();
    expect(await outcome).toEqual({ behavior: 'deny', message: 'interrupted' });
    expect(approvals.pending()).toEqual([]);
    expect(runner.state).toBe('running'); // the interrupted turn still has to yield its result
  });

  it('an error result marks the session error with the reason and a new send starts fresh', async () => {
    const { client, runner, states } = setup();
    await runner.send('x', { mode: 'steer', origin: 'user' });
    await tick();
    client.result('error_during_execution: session not found');
    await tick();
    expect(runner.state).toBe('error');
    expect(runner.error).toBe('error_during_execution: session not found');
    await runner.send('again', { mode: 'steer', origin: 'user' });
    await tick();
    expect(client.starts).toHaveLength(2);
    expect(runner.state).toBe('running');
    expect(states).toEqual(['running', 'error', 'running']);
  });

  it('a run that throws mid-turn marks error and denies pending approvals', async () => {
    const { client, approvals, runner } = setup();
    await runner.send('x', { mode: 'steer', origin: 'user' });
    await tick();
    const outcome = client.askTool('Bash', { command: 'git clean -fd' });
    await tick();
    client.die(new Error('process exited'));
    await tick();
    await tick();
    expect(runner.state).toBe('error');
    expect(runner.error).toBe('process exited');
    expect(await outcome).toEqual({ behavior: 'deny', message: 'process exited' });
    expect(approvals.pending()).toEqual([]);
  });

  it('close ends input, cancels approvals and forgets allow-patterns', async () => {
    const { client, approvals, runner } = setup();
    await runner.send('x', { mode: 'steer', origin: 'user' });
    await tick();
    const first = client.askTool('Bash', { command: 'git push -f' });
    await tick();
    approvals.decide(approvals.pending()[0]!.id, { kind: 'allow-pattern' });
    await first;
    client.result();
    await tick();
    await runner.close();
    // a fresh runner for the same session asks again
    const again = new SessionRunner({ sessionId: 's1', cwd: '/repo', client, approvals });
    await again.send('y', { mode: 'steer', origin: 'user' });
    await tick();
    void client.askTool('Bash', { command: 'git push -f' });
    await tick();
    expect(approvals.pending()).toHaveLength(1);
    await again.close();
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `pnpm --filter @relay/engine test session-runner` → FAIL, module not found.

- [ ] **Step 4: Implementation**

```ts
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { DeliveryMode, LiveEntry, MessageOrigin, SessionState } from '@relay/shared';
import type { ApprovalQueue } from '../approvals/approval-queue';
import type { AgentClient, AgentInput, AgentRun } from './agent-client';
import { AsyncQueue } from './async-queue';

export interface SessionRunnerOptions {
  sessionId: string;
  cwd: string;
  client: AgentClient;
  approvals: ApprovalQueue;
}

type RunnerEvents = { state: [SessionState, string | null]; entry: [LiveEntry] };

/** Drives one session: owns the agent run, tracks its state and relays its output. */
export class SessionRunner extends EventEmitter<RunnerEvents> {
  readonly sessionId: string;
  private readonly cwd: string;
  private readonly client: AgentClient;
  private readonly approvals: ApprovalQueue;
  private input: AsyncQueue<AgentInput> | null = null;
  private run: AgentRun | null = null;
  private consuming: Promise<void> | null = null;
  private outstanding = 0;
  private lastOrigin: MessageOrigin | null = null;
  /** Ids of this session's approvals still waiting for a decision. */
  private readonly pendingIds = new Set<string>();
  private _state: SessionState = 'idle';
  private _error: string | null = null;
  private readonly onPending = (p: PendingApproval) => {
    if (p.sessionId !== this.sessionId) return;
    this.pendingIds.add(p.id);
    this.setState('waiting-approval');
  };
  private readonly onResolved = (id: string) => {
    if (!this.pendingIds.delete(id)) return;
    if (this.pendingIds.size === 0 && this._state === 'waiting-approval') this.setState('running');
  };

  constructor(opts: SessionRunnerOptions) {
    super();
    this.sessionId = opts.sessionId;
    this.cwd = opts.cwd;
    this.client = opts.client;
    this.approvals = opts.approvals;
    this.approvals.on('pending', this.onPending);
    this.approvals.on('resolved', this.onResolved);
  }

  get state(): SessionState {
    return this._state;
  }

  get error(): string | null {
    return this._error;
  }

  async send(prompt: string, opts: { mode: DeliveryMode; origin: MessageOrigin }): Promise<string> {
    if (!this.run) this.startRun();
    if (opts.mode === 'interrupt') await this.interrupt();
    this.outstanding += 1;
    this.lastOrigin = opts.origin;
    this.input!.push({ text: prompt, priority: opts.mode === 'queue' ? 'next' : 'now', origin: opts.origin });
    this.setState('running');
    return randomUUID();
  }

  async interrupt(): Promise<void> {
    if (!this.run) return;
    this.approvals.cancelSession(this.sessionId, 'interrupted');
    await this.run.interrupt();
  }

  async close(): Promise<void> {
    this.approvals.cancelSession(this.sessionId, 'session closed');
    this.approvals.forgetSession(this.sessionId);
    this.approvals.off('pending', this.onPending);
    this.approvals.off('resolved', this.onResolved);
    this.input?.end();
    await this.consuming;
    this.run = null;
    this.input = null;
  }

  private startRun(): void {
    this._error = null;
    this.input = new AsyncQueue<AgentInput>();
    this.run = this.client.start({
      sessionId: this.sessionId,
      cwd: this.cwd,
      input: this.input,
      canUseTool: (toolName, input, blockedPath, signal) =>
        this.approvals.request({ sessionId: this.sessionId, toolName, input, cwd: this.cwd, blockedPath, signal }),
    });
    this.consuming = this.consume(this.run).catch((err: unknown) => this.fail(err instanceof Error ? err.message : String(err)));
  }

  private async consume(run: AgentRun): Promise<void> {
    for await (const m of run.messages) {
      switch (m.type) {
        case 'assistant':
        case 'tool-results':
          this.emit('entry', {
            uuid: m.uuid,
            role: m.type === 'assistant' ? 'assistant' : 'user',
            timestamp: m.timestamp,
            isSidechain: false,
            isMeta: false,
            blocks: m.blocks,
            origin: this.lastOrigin,
          });
          break;
        case 'result':
          if (m.isError) {
            this.fail(m.error ?? 'unknown error');
            return;
          }
          this.outstanding = Math.max(0, this.outstanding - 1);
          if (this.outstanding === 0 && this.pendingIds.size === 0) this.setState('idle');
          break;
        case 'init':
          break;
      }
    }
  }

  private fail(reason: string): void {
    this.approvals.cancelSession(this.sessionId, reason);
    this.input?.end();
    this.run = null;
    this.input = null;
    this.outstanding = 0;
    this.pendingIds.clear();
    this._error = reason;
    this.setState('error');
  }

  private setState(state: SessionState): void {
    if (state === this._state) return;
    this._state = state;
    this.emit('state', state, this._error);
  }
}
```

Import `PendingApproval` from `@relay/shared` alongside the other types. `fail()` runs `cancelSession` first, which emits `resolved` for each pending id and lets `onResolved` clear them before `setState('error')`; `pendingIds.clear()` is only a safety net.

Add to `src/index.ts`:
```ts
export { SessionRunner } from './runner/session-runner';
export type { SessionRunnerOptions } from './runner/session-runner';
```

- [ ] **Step 5: Run to verify pass, commit**

Run: `pnpm --filter @relay/engine test session-runner` → PASS (8 tests).

```bash
git add packages/engine
git commit -m "feat(engine): SessionRunner with steer/queue/interrupt and approval-aware state"
```

---

### Task 7: RelayEngine — send, interrupt, decide, runState, onEvent

**Files:**
- Modify: `packages/engine/src/relay-engine.ts`
- Create: `packages/engine/src/runner/session-busy-error.ts`
- Test: `packages/engine/test/relay-engine.test.ts` (extend)

**Interfaces:**
- Consumes: `SessionRunner`, `ApprovalQueue`, `AgentClient`, `RunnerEvent`, `RunState`.
- Produces:
  ```ts
  interface RelayEngineOptions { projectsDir; dbPath; git?; agent?: AgentClient; now?: () => Date }
  class RelayEngine {
    send(req: { sessionId; prompt; mode; origin }): Promise<string>     // throws SessionBusyError / Unknown session
    interrupt(sessionId: string): Promise<void>
    decide(approvalId: string, decision: ApprovalDecision): void
    runState(): RunState
    onEvent(listener: (e: RunnerEvent) => void): () => void
  }
  class SessionBusyError extends Error { sessionId: string }
  ```

- [ ] **Step 1: Failing tests** (append to the existing describe; reuse its `root`/`engine` variables and `afterEach`). Extend the file's `node:fs/promises` import to `{ copyFile, mkdir, mkdtemp, readFile, rm, utimes, writeFile }` and add:

```ts
import type { RunnerEvent } from '@relay/shared';
import { SessionBusyError } from '../src/runner/session-busy-error';
import { FakeAgentClient, tick } from './runner/fake-agent-client';

async function startWithBasic(client: FakeAgentClient, now = () => new Date('2026-09-23T00:00:00.000Z')) {
  root = await mkdtemp(join(tmpdir(), 'relay-engine-'));
  const cwd = join(root, 'wt-a');
  await mkdir(cwd);
  await mkdir(join(root, 'projects', 'p'), { recursive: true });
  const src = await readFile(fixture('basic.jsonl'), 'utf8');
  const file = join(root, 'projects', 'p', 's-basic.jsonl');
  await writeFile(file, src.replaceAll('/repo/wt-a', cwd));
  const old = new Date('2026-09-20T10:01:00.000Z');
  await utimes(file, old, old); // last written days ago: nobody else is driving it
  engine = await RelayEngine.start({
    projectsDir: join(root, 'projects'), dbPath: join(root, 'relay.db'),
    git: { inspect: async () => ({ branch: 'feat/a', repo: 'r' }) }, agent: client, now,
  });
  return { cwd, file };
}

it('send starts a runner for a listed session and relays events', async () => {
  const client = new FakeAgentClient();
  const { cwd } = await startWithBasic(client);
  const events: RunnerEvent[] = [];
  engine!.onEvent((e) => events.push(e));
  await engine!.send({ sessionId: 's-basic', prompt: 'hi', mode: 'steer', origin: 'user' });
  await tick();
  expect(client.starts[0]).toMatchObject({ sessionId: 's-basic', cwd });
  client.assistant('a9', 'hello');
  client.result();
  await tick();
  expect(events.map((e) => e.type)).toEqual(['state', 'entry', 'state']);
  expect(engine!.runState().states['s-basic']).toEqual({ state: 'idle', error: null });
});

it('send refuses a session whose transcript someone else wrote in the last 15 s', async () => {
  const client = new FakeAgentClient();
  const { file } = await startWithBasic(client);
  const now = new Date();
  await utimes(file, now, now);
  await expect(engine!.send({ sessionId: 's-basic', prompt: 'hi', mode: 'steer', origin: 'user' })).rejects.toBeInstanceOf(SessionBusyError);
  expect(client.starts).toHaveLength(0);
});

it('send rejects an unknown session id', async () => {
  await startWithBasic(new FakeAgentClient());
  await expect(engine!.send({ sessionId: 'nope', prompt: 'x', mode: 'steer', origin: 'user' })).rejects.toThrow(/unknown session/i);
});

it('approvals surface as events and decide() settles them', async () => {
  const client = new FakeAgentClient();
  await startWithBasic(client);
  const events: RunnerEvent[] = [];
  engine!.onEvent((e) => events.push(e));
  await engine!.send({ sessionId: 's-basic', prompt: 'push', mode: 'steer', origin: 'user' });
  await tick();
  const outcome = client.askTool('Bash', { command: 'git push --force' });
  await tick();
  const approval = engine!.runState().approvals[0]!;
  expect(events.find((e) => e.type === 'approval')).toMatchObject({ approval: { id: approval.id, reason: 'destructive-git' } });
  engine!.decide(approval.id, { kind: 'deny', message: 'no' });
  expect(await outcome).toEqual({ behavior: 'deny', message: 'no' });
  expect(events.at(-1)).toMatchObject({ type: 'approval-resolved', approvalId: approval.id, decision: 'deny' });
});
```
The `now` option matters for the busy check: pass `now: () => new Date()` (the default) in the busy test so the freshly-touched file counts as recent — the helper's fixed `now` of 2026-09-23 would make it look old or in the future. Call `startWithBasic(client, () => new Date())` there.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @relay/engine test relay-engine` → FAIL (`send` is not a function / module not found).

- [ ] **Step 3: Implementation**

`packages/engine/src/runner/session-busy-error.ts`:
```ts
/** Someone else (a terminal) is writing this session's transcript; Relay must not drive it too. */
export class SessionBusyError extends Error {
  constructor(readonly sessionId: string) {
    super(`Session ${sessionId} is being written by another process`);
    this.name = 'SessionBusyError';
  }
}
```

`packages/engine/src/relay-engine.ts` — replace with:
```ts
import { stat } from 'node:fs/promises';
import type {
  ApprovalDecision, DeliveryMode, MessageOrigin, RunnerEvent, RunState, SessionSummary, TranscriptEntry,
} from '@relay/shared';
import { ApprovalQueue } from './approvals/approval-queue';
import { ExecGitInfoProvider, type GitInfoProvider } from './git/git-info';
import { SessionIndex } from './index/session-index';
import type { AgentClient } from './runner/agent-client';
import { SdkAgentClient } from './runner/sdk-agent-client';
import { SessionBusyError } from './runner/session-busy-error';
import { SessionRunner } from './runner/session-runner';
import { SessionStore } from './store/session-store';

/** A transcript written more recently than this is assumed to have another writer. */
const BUSY_WINDOW_MS = 15_000;

export interface RelayEngineOptions {
  projectsDir: string;
  dbPath: string;
  git?: GitInfoProvider;
  agent?: AgentClient;
  now?: () => Date;
}

export interface SendOptions {
  sessionId: string;
  prompt: string;
  mode: DeliveryMode;
  origin: MessageOrigin;
}

/** The single entry point the desktop app (and later a daemon) talks to. */
export class RelayEngine {
  private readonly runners = new Map<string, SessionRunner>();
  private readonly listeners = new Set<(e: RunnerEvent) => void>();

  private constructor(
    private readonly store: SessionStore,
    private readonly index: SessionIndex,
    private readonly agent: AgentClient,
    private readonly approvals: ApprovalQueue,
    private readonly now: () => Date,
  ) {
    approvals.on('pending', (approval) => this.publish({ type: 'approval', approval }));
    approvals.on('resolved', (approvalId, decision) => this.publish({ type: 'approval-resolved', approvalId, decision }));
  }

  static async start(opts: RelayEngineOptions): Promise<RelayEngine> {
    const store = new SessionStore(opts.dbPath);
    const index = new SessionIndex({ projectsDir: opts.projectsDir, store, git: opts.git ?? new ExecGitInfoProvider() });
    await index.scan();
    index.watch();
    return new RelayEngine(store, index, opts.agent ?? new SdkAgentClient(), new ApprovalQueue(), opts.now ?? (() => new Date()));
  }

  listSessions(): SessionSummary[] {
    return this.index.list();
  }

  getTranscript(id: string): Promise<TranscriptEntry[]> {
    return this.index.getTranscript(id);
  }

  onSessionsChanged(listener: (sessions: SessionSummary[]) => void): () => void {
    this.index.on('changed', listener);
    return () => this.index.off('changed', listener);
  }

  /** Non-fatal indexing problems (an unreadable transcript, a failed rescan). */
  onError(listener: (error: Error) => void): () => void {
    this.index.on('error', listener);
    return () => this.index.off('error', listener);
  }

  onEvent(listener: (event: RunnerEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async send(opts: SendOptions): Promise<string> {
    const runner = this.runners.get(opts.sessionId) ?? (await this.createRunner(opts.sessionId));
    return runner.send(opts.prompt, { mode: opts.mode, origin: opts.origin });
  }

  async interrupt(sessionId: string): Promise<void> {
    await this.runners.get(sessionId)?.interrupt();
  }

  decide(approvalId: string, decision: ApprovalDecision): void {
    this.approvals.decide(approvalId, decision);
  }

  runState(): RunState {
    const states: RunState['states'] = {};
    for (const [id, r] of this.runners) states[id] = { state: r.state, error: r.error };
    return { states, approvals: this.approvals.pending() };
  }

  async close(): Promise<void> {
    await Promise.all([...this.runners.values()].map((r) => r.close()));
    await this.index.close();
    this.store.close();
  }

  private async createRunner(sessionId: string): Promise<SessionRunner> {
    const session = this.index.list().find((s) => s.id === sessionId);
    if (!session) throw new Error(`Unknown session ${sessionId}`);
    const { mtimeMs } = await stat(session.filePath);
    if (this.now().getTime() - mtimeMs < BUSY_WINDOW_MS) throw new SessionBusyError(sessionId);
    const runner = new SessionRunner({ sessionId, cwd: session.cwd, client: this.agent, approvals: this.approvals });
    runner.on('state', (state, error) => this.publish({ type: 'state', sessionId, state, error }));
    runner.on('entry', (entry) => this.publish({ type: 'entry', sessionId, entry }));
    this.runners.set(sessionId, runner);
    return runner;
  }

  private publish(event: RunnerEvent): void {
    for (const l of this.listeners) l(event);
  }
}
```

Add to `src/index.ts`: `export { SessionBusyError } from './runner/session-busy-error'; export type { SendOptions } from './relay-engine';`

- [ ] **Step 4: Run to verify pass, commit**

Run: `pnpm --filter @relay/engine test && pnpm typecheck` → all PASS / Done.

```bash
git add packages/engine
git commit -m "feat(engine): RelayEngine drives sessions — send, interrupt, decide, run state, events"
```

---

### Task 8: Desktop IPC and preload for the runner

**Files:**
- Modify: `packages/shared/src/ipc.ts` (extend `RelayApi`), `apps/desktop/src/ipc.ts`, `apps/desktop/src/preload.ts`, `apps/desktop/src/main.ts`

**Interfaces:**
- Consumes: `RelayEngine.send/interrupt/decide/runState/onEvent`, IPC names (Task 1).
- Produces: `window.relay.send / interrupt / decide / runState / onRunnerEvent` (the full `RelayApi` from Task 1's listing).

- [ ] **Step 1: Extend `RelayApi`** in `packages/shared/src/ipc.ts` with the five members shown in Task 1. Run `pnpm typecheck` → **expected FAIL** in `apps/desktop/src/preload.ts` (`send` missing). That is the red step for this task.

- [ ] **Step 2: Main-process handlers** — `apps/desktop/src/ipc.ts`, replace the body of `registerEngineIpc`:
```ts
export function registerEngineIpc(engine: RelayEngine): () => void {
  const handle = <T>(channel: string, fn: (event: IpcMainInvokeEvent, ...args: never[]) => T) => {
    ipcMain.handle(channel, (event, ...args) => {
      assertTrusted(event);
      return fn(event, ...(args as never[]));
    });
  };
  handle(IPC.listSessions, () => engine.listSessions());
  handle(IPC.getTranscript, (_e, id: string) => engine.getTranscript(id));
  handle(IPC.send, (_e, req: SendRequest) => engine.send(req));
  handle(IPC.interrupt, (_e, id: string) => engine.interrupt(id));
  handle(IPC.decide, (_e, id: string, decision: ApprovalDecision) => engine.decide(id, decision));
  handle(IPC.runState, () => engine.runState());

  const broadcast = (channel: string, payload: unknown) => {
    for (const win of BrowserWindow.getAllWindows()) win.webContents.send(channel, payload);
  };
  const unsubs = [
    engine.onSessionsChanged((sessions) => broadcast(IPC.sessionsChanged, sessions)),
    engine.onEvent((event) => broadcast(IPC.runnerEvent, event)),
  ];
  return () => {
    for (const u of unsubs) u();
    for (const c of [IPC.listSessions, IPC.getTranscript, IPC.send, IPC.interrupt, IPC.decide, IPC.runState]) ipcMain.removeHandler(c);
  };
}
```
Import `SendRequest` and `ApprovalDecision` types from `@relay/shared`.

- [ ] **Step 3: Preload** — `apps/desktop/src/preload.ts`:
```ts
import { contextBridge, ipcRenderer } from 'electron';
import { IPC, type RelayApi, type RunnerEvent, type SessionSummary } from '@relay/shared';

function subscribe<T>(channel: string, listener: (payload: T) => void): () => void {
  const handler = (_e: unknown, payload: T) => listener(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.off(channel, handler);
}

const api: RelayApi = {
  listSessions: () => ipcRenderer.invoke(IPC.listSessions),
  getTranscript: (id) => ipcRenderer.invoke(IPC.getTranscript, id),
  onSessionsChanged: (listener) => subscribe<SessionSummary[]>(IPC.sessionsChanged, listener),
  send: (request) => ipcRenderer.invoke(IPC.send, request),
  interrupt: (sessionId) => ipcRenderer.invoke(IPC.interrupt, sessionId),
  decide: (approvalId, decision) => ipcRenderer.invoke(IPC.decide, approvalId, decision),
  runState: () => ipcRenderer.invoke(IPC.runState),
  onRunnerEvent: (listener) => subscribe<RunnerEvent>(IPC.runnerEvent, listener),
};

contextBridge.exposeInMainWorld('relay', api);
```

- [ ] **Step 4: Notification in main** — in `apps/desktop/src/main.ts` `start()`, after `registerEngineIpc(engine)`:
```ts
  engine.onEvent((event) => {
    if (event.type === 'approval') {
      new Notification({ title: 'Relay Hub: approval needed', body: event.approval.summary }).show();
    } else if (event.type === 'state' && event.state === 'error') {
      new Notification({ title: 'Relay Hub: session error', body: event.error ?? 'unknown error' }).show();
    }
  });
```
Add `Notification` to the `electron` import.

- [ ] **Step 5: Typecheck, run, commit**

Run: `pnpm typecheck` → all Done. Run `pnpm --filter @relay/desktop test` → still 8 passed (the `App.test` fake `relay` object gains no new members yet; TypeScript accepts it because the test builds it as a mapped type of `RelayApi` — add the five new `vi.fn()` members there so it compiles: `send: vi.fn()`, `interrupt: vi.fn()`, `decide: vi.fn()`, `runState: vi.fn().mockResolvedValue({ states: {}, approvals: [] })`, `onRunnerEvent: vi.fn(() => () => undefined)`).

```bash
git add packages/shared apps/desktop
git commit -m "feat(desktop): IPC for send, interrupt, decide, run state and runner events"
```

---

### Task 9: Session panel — state, live entries, approvals, dev send box

**Files:**
- Create: `apps/desktop/src/ui/SessionPanel.tsx`, `apps/desktop/src/ui/SessionPanel.test.tsx`, `apps/desktop/src/ui/useRunState.ts`, `apps/desktop/src/ui/ApprovalCard.tsx`
- Modify: `apps/desktop/src/ui/App.tsx`, `apps/desktop/src/ui/App.test.tsx`, `apps/desktop/src/ui/TranscriptView.tsx`, `apps/desktop/src/ui/SessionList.tsx`, `apps/desktop/src/ui/styles.css`

**Interfaces:**
- Consumes: `window.relay` (Task 8), `RunnerEvent`, `LiveEntry`, `PendingApproval`.
- Produces:
  ```ts
  function useRunState(): { states: RunState['states']; approvals: PendingApproval[]; liveEntries: Record<string, LiveEntry[]> }
  <SessionPanel session entries liveEntries state approvals showSidechain onToggleSidechain onDecide onSend onInterrupt devTools />
  <ApprovalCard approval onDecide />
  ```
  Merge rule: the panel shows `entries` (from the file) followed by any `liveEntries` whose `uuid` is not already in `entries`; when the file refetch catches up, the live ones drop out naturally.

- [ ] **Step 1: Failing tests**

`apps/desktop/src/ui/SessionPanel.test.tsx`:
```tsx
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { LiveEntry, PendingApproval, SessionSummary, TranscriptEntry } from '@relay/shared';
import { SessionPanel } from './SessionPanel';

const session: SessionSummary = {
  id: 'a', filePath: '/f', cwd: '/repo', cwdExists: true, repo: 'repo', branch: 'feat/a', title: 'Alpha',
  lastActivity: '2026-09-20T00:00:00.000Z', messageCount: 1, prNumber: null, prUrl: null, continuedIn: null, isStale: false,
};
const entry = (uuid: string, text: string): TranscriptEntry => ({
  uuid, role: 'assistant', timestamp: '2026-09-20T00:00:00.000Z', isSidechain: false, isMeta: false, blocks: [{ kind: 'text', text }],
});
const live = (uuid: string, text: string): LiveEntry => ({ ...entry(uuid, text), origin: 'orchestrator' });
const approval: PendingApproval = {
  id: 'ap1', sessionId: 'a', toolName: 'Bash', input: { command: 'git push --force' }, summary: 'git push --force',
  reason: 'destructive-git', cwd: '/repo', createdAt: '2026-09-23T00:00:00.000Z',
};

const base = {
  session, showSidechain: false, onToggleSidechain: vi.fn(), onDecide: vi.fn(), onSend: vi.fn(), onInterrupt: vi.fn(), devTools: true,
};

describe('SessionPanel', () => {
  it('shows state, merges live entries by uuid and tags their origin', () => {
    render(
      <SessionPanel {...base} entries={[entry('e1', 'from file')]} liveEntries={[live('e1', 'dup'), live('e2', 'streamed')]}
        state={{ state: 'running', error: null }} approvals={[]} />,
    );
    expect(screen.getByText('running')).toBeInTheDocument();
    expect(screen.getByText('from file')).toBeInTheDocument();
    expect(screen.queryByText('dup')).not.toBeInTheDocument();
    expect(screen.getByText('streamed')).toBeInTheDocument();
    expect(screen.getByText('orchestrator')).toBeInTheDocument();
  });

  it('renders pending approvals with three decisions', async () => {
    const onDecide = vi.fn();
    render(<SessionPanel {...base} onDecide={onDecide} entries={[]} liveEntries={[]} state={{ state: 'waiting-approval', error: null }} approvals={[approval]} />);
    expect(screen.getByText('git push --force')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Allow once' }));
    await userEvent.click(screen.getByRole('button', { name: 'Deny' }));
    await userEvent.click(screen.getByRole('button', { name: 'Allow this kind for this run' }));
    expect(onDecide.mock.calls).toEqual([
      ['ap1', { kind: 'allow-once' }], ['ap1', { kind: 'deny' }], ['ap1', { kind: 'allow-pattern' }],
    ]);
  });

  it('dev send box sends with the chosen mode and can interrupt', async () => {
    const onSend = vi.fn();
    const onInterrupt = vi.fn();
    render(<SessionPanel {...base} onSend={onSend} onInterrupt={onInterrupt} entries={[]} liveEntries={[]} state={{ state: 'idle', error: null }} approvals={[]} />);
    await userEvent.type(screen.getByPlaceholderText('Send to this session (dev)'), 'add tests');
    await userEvent.selectOptions(screen.getByLabelText('Delivery'), 'queue');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(onSend).toHaveBeenCalledWith('add tests', 'queue');
    await userEvent.click(screen.getByRole('button', { name: 'Interrupt' }));
    expect(onInterrupt).toHaveBeenCalledTimes(1);
  });

  it('shows the error reason and hides the dev box when devTools is off', () => {
    render(<SessionPanel {...base} devTools={false} entries={[]} liveEntries={[]} state={{ state: 'error', error: 'session not found' }} approvals={[]} />);
    expect(screen.getByText('session not found')).toBeInTheDocument();
    expect(screen.queryByPlaceholderText('Send to this session (dev)')).not.toBeInTheDocument();
  });
});
```

In `App.test.tsx` add one test:
```tsx
  it('appends runner entries for the selected session live', async () => {
    let emit: ((e: RunnerEvent) => void) | null = null;
    relay.onRunnerEvent.mockImplementation((l: (e: RunnerEvent) => void) => { emit = l; return () => undefined; });
    render(<App />);
    await userEvent.click(await screen.findByText('Alpha'));
    await act(async () => {
      emit!({ type: 'entry', sessionId: 'a', entry: { uuid: 'live1', role: 'assistant', timestamp: '2026-09-23T00:00:00.000Z', isSidechain: false, isMeta: false, blocks: [{ kind: 'text', text: 'streamed now' }], origin: 'user' } });
      emit!({ type: 'entry', sessionId: 'b', entry: { uuid: 'live2', role: 'assistant', timestamp: '2026-09-23T00:00:00.000Z', isSidechain: false, isMeta: false, blocks: [{ kind: 'text', text: 'other session' }], origin: 'user' } });
      emit!({ type: 'state', sessionId: 'a', state: 'running', error: null });
    });
    expect(screen.getByText('streamed now')).toBeInTheDocument();
    expect(screen.queryByText('other session')).not.toBeInTheDocument();
    expect(screen.getAllByText('running').length).toBeGreaterThan(0);
  });
```
(import `RunnerEvent` from `@relay/shared`).

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @relay/desktop test` → FAIL: `./SessionPanel` not found; App test fails on missing text.

- [ ] **Step 3: Implementation**

`apps/desktop/src/ui/useRunState.ts`:
```ts
import { useEffect, useState } from 'react';
import type { LiveEntry, PendingApproval, RunState, RunnerEvent } from '@relay/shared';

export interface RunView {
  states: RunState['states'];
  approvals: PendingApproval[];
  liveEntries: Record<string, LiveEntry[]>;
}

/** Mirrors the engine's run state in the renderer: initial snapshot, then events. */
export function useRunState(): RunView {
  const [view, setView] = useState<RunView>({ states: {}, approvals: [], liveEntries: {} });
  useEffect(() => {
    void window.relay.runState().then((s) => setView((v) => ({ ...v, states: s.states, approvals: s.approvals })));
    return window.relay.onRunnerEvent((event: RunnerEvent) => {
      setView((v) => {
        switch (event.type) {
          case 'state':
            return { ...v, states: { ...v.states, [event.sessionId]: { state: event.state, error: event.error } } };
          case 'entry':
            return { ...v, liveEntries: { ...v.liveEntries, [event.sessionId]: [...(v.liveEntries[event.sessionId] ?? []), event.entry] } };
          case 'approval':
            return { ...v, approvals: [...v.approvals, event.approval] };
          case 'approval-resolved':
            return { ...v, approvals: v.approvals.filter((a) => a.id !== event.approvalId) };
        }
      });
    });
  }, []);
  return view;
}
```

`apps/desktop/src/ui/ApprovalCard.tsx`:
```tsx
import type { ApprovalDecision, PendingApproval } from '@relay/shared';

interface Props {
  approval: PendingApproval;
  onDecide: (id: string, decision: ApprovalDecision) => void;
}

const REASONS: Record<PendingApproval['reason'], string> = {
  'destructive-git': 'Destructive git command',
  'outside-cwd': 'Touches a path outside the session directory',
  'blocked-path': 'Path blocked by Claude Code',
};

export function ApprovalCard({ approval, onDecide }: Props) {
  return (
    <div className="approval" role="group" aria-label="Approval">
      <div className="approval__reason">{REASONS[approval.reason]}</div>
      <code className="approval__summary">{approval.summary}</code>
      <div className="approval__meta">{approval.toolName} · {approval.cwd}</div>
      <div className="approval__actions">
        <button type="button" onClick={() => onDecide(approval.id, { kind: 'allow-once' })}>Allow once</button>
        <button type="button" onClick={() => onDecide(approval.id, { kind: 'deny' })}>Deny</button>
        <button type="button" onClick={() => onDecide(approval.id, { kind: 'allow-pattern' })}>Allow this kind for this run</button>
      </div>
    </div>
  );
}
```

`apps/desktop/src/ui/TranscriptView.tsx` — accept `LiveEntry | TranscriptEntry` and show the origin when present: change the prop type to `entries: Array<TranscriptEntry & { origin?: LiveEntry['origin'] }>` and in the `<header>` add `{e.origin && <span className="origin">{e.origin}</span>}` between role and time.

`apps/desktop/src/ui/SessionPanel.tsx`:
```tsx
import { useState } from 'react';
import type { ApprovalDecision, DeliveryMode, LiveEntry, PendingApproval, SessionSummary, TranscriptEntry } from '@relay/shared';
import { ApprovalCard } from './ApprovalCard';
import { TranscriptView } from './TranscriptView';

interface Props {
  session: SessionSummary;
  entries: TranscriptEntry[];
  liveEntries: LiveEntry[];
  state: { state: string; error: string | null } | undefined;
  approvals: PendingApproval[];
  showSidechain: boolean;
  onToggleSidechain: (v: boolean) => void;
  onDecide: (id: string, decision: ApprovalDecision) => void;
  onSend: (prompt: string, mode: DeliveryMode) => void;
  onInterrupt: () => void;
  devTools: boolean;
}

/** File entries first, then live ones the file has not caught up with yet. */
function merge(entries: TranscriptEntry[], live: LiveEntry[]): Array<TranscriptEntry & { origin?: LiveEntry['origin'] }> {
  const seen = new Set(entries.map((e) => e.uuid));
  return [...entries, ...live.filter((e) => !seen.has(e.uuid))];
}

export function SessionPanel(p: Props) {
  const [draft, setDraft] = useState('');
  const [mode, setMode] = useState<DeliveryMode>('steer');
  const state = p.state?.state ?? 'idle';
  const submit = () => {
    if (!draft.trim()) return;
    p.onSend(draft, mode);
    setDraft('');
  };
  return (
    <>
      <header className="session-panel__header">
        <h1>{p.session.title}</h1>
        <p>
          <span className={`state state--${state}`}>{state}</span> <code>{p.session.cwd}</code>{' '}
          {p.session.branch && <code>{p.session.branch}</code>}{' '}
          {p.session.prUrl && <a href={p.session.prUrl} target="_blank" rel="noreferrer">PR #{p.session.prNumber}</a>}
        </p>
        {p.state?.error && <p className="error">{p.state.error}</p>}
        <label>
          <input type="checkbox" checked={p.showSidechain} onChange={(e) => p.onToggleSidechain(e.target.checked)} /> Show subagent turns
        </label>
      </header>
      {p.approvals.map((a) => <ApprovalCard key={a.id} approval={a} onDecide={p.onDecide} />)}
      <TranscriptView entries={merge(p.entries, p.liveEntries)} hideSidechain={!p.showSidechain} />
      {p.devTools && (
        <form className="dev-send" onSubmit={(e) => { e.preventDefault(); submit(); }}>
          <textarea placeholder="Send to this session (dev)" value={draft} onChange={(e) => setDraft(e.target.value)} rows={2} />
          <div className="dev-send__row">
            <select aria-label="Delivery" value={mode} onChange={(e) => setMode(e.target.value as DeliveryMode)}>
              <option value="steer">steer</option>
              <option value="queue">queue</option>
              <option value="interrupt">interrupt</option>
            </select>
            <button type="submit">Send</button>
            <button type="button" onClick={p.onInterrupt}>Interrupt</button>
          </div>
        </form>
      )}
    </>
  );
}
```

`apps/desktop/src/ui/App.tsx` — replace the right column's inner JSX with `SessionPanel`, wire `useRunState`, and pass:
```tsx
const run = useRunState();
...
{selected ? (
  <SessionPanel
    session={selected}
    entries={entries}
    liveEntries={run.liveEntries[selected.id] ?? []}
    state={run.states[selected.id]}
    approvals={run.approvals.filter((a) => a.sessionId === selected.id)}
    showSidechain={showSidechain}
    onToggleSidechain={setShowSidechain}
    onDecide={(id, d) => void window.relay.decide(id, d)}
    onSend={(prompt, mode) => void window.relay.send({ sessionId: selected.id, prompt, mode, origin: 'user' }).catch((e: unknown) => setSendError(String(e)))}
    onInterrupt={() => void window.relay.interrupt(selected.id)}
    devTools={import.meta.env.DEV}
  />
) : (<p className="placeholder">Select a session.</p>)}
```
`import.meta.env.DEV` needs Vite's client types: add `"vite/client"` to `types` in `apps/desktop/tsconfig.json` (`"types": ["node", "vite/client"]`). Add `const [sendError, setSendError] = useState<string | null>(null);` and render `{sendError && <p className="error">{sendError}</p>}` above the panel; clear it on `selectedId` change. Keep the follow-the-bottom effect; add `run.liveEntries` to its dependency list so streamed entries scroll too. In `SessionList.tsx` accept an optional `states?: RunState['states']` prop and render `<span className={`dot dot--${states?.[s.id]?.state ?? 'idle'}`} />` at the start of each row; pass `run.states` from `App`.

Add to `styles.css`:
```css
.state { font-size: 11px; border-radius: 10px; padding: 1px 8px; border: 1px solid currentColor; }
.state--running { color: #2d7ff9; } .state--waiting-approval { color: #d98a00; } .state--error { color: #c0392b; }
.dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 6px; background: currentColor; opacity: .25; }
.dot--running { background: #2d7ff9; opacity: 1; } .dot--waiting-approval { background: #d98a00; opacity: 1; } .dot--error { background: #c0392b; opacity: 1; }
.approval { border: 1px solid #d98a00; border-radius: 8px; padding: 8px 10px; margin: 0 0 10px; }
.approval__reason { font-weight: 600; margin-bottom: 4px; }
.approval__summary { display: block; white-space: pre-wrap; margin: 4px 0; }
.approval__meta { font-size: 11px; opacity: .6; }
.approval__actions { display: flex; gap: 6px; margin-top: 6px; }
.origin { font-style: italic; }
.error { color: #c0392b; }
.dev-send { position: sticky; bottom: 0; background: Canvas; padding-top: 8px; }
.dev-send textarea { width: 100%; box-sizing: border-box; }
.dev-send__row { display: flex; gap: 6px; margin-top: 4px; }
```

- [ ] **Step 4: Run to verify pass, typecheck, commit**

Run: `pnpm --filter @relay/desktop test && pnpm typecheck` → PASS / Done.

```bash
git add apps/desktop
git commit -m "feat(desktop): session panel with run state, live entries, approvals and a dev send box"
```

---

### Task 10: Approvals drawer under the orchestrator column

**Files:**
- Create: `apps/desktop/src/ui/ApprovalsDrawer.tsx`, `apps/desktop/src/ui/ApprovalsDrawer.test.tsx`
- Modify: `apps/desktop/src/ui/App.tsx`, `apps/desktop/src/ui/styles.css`

**Interfaces:**
- Consumes: `ApprovalCard`, `PendingApproval`, `SessionSummary`.
- Produces: `<ApprovalsDrawer approvals sessions onDecide onOpenSession />` — every pending approval across sessions, each with its session title and a link to open that session.

- [ ] **Step 1: Failing test**

```tsx
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { PendingApproval, SessionSummary } from '@relay/shared';
import { ApprovalsDrawer } from './ApprovalsDrawer';

const s = (id: string, title: string): SessionSummary => ({
  id, filePath: '/f', cwd: '/c', cwdExists: true, repo: 'repo', branch: 'main', title,
  lastActivity: '2026-09-20T00:00:00.000Z', messageCount: 1, prNumber: null, prUrl: null, continuedIn: null, isStale: false,
});
const ap = (id: string, sessionId: string, summary: string): PendingApproval => ({
  id, sessionId, toolName: 'Bash', input: { command: summary }, summary, reason: 'destructive-git', cwd: '/c', createdAt: '2026-09-23T00:00:00.000Z',
});

describe('ApprovalsDrawer', () => {
  it('lists approvals across sessions with their session title and opens a session', async () => {
    const onOpen = vi.fn();
    const onDecide = vi.fn();
    render(
      <ApprovalsDrawer
        approvals={[ap('1', 'a', 'git push -f'), ap('2', 'b', 'git clean -fd')]}
        sessions={[s('a', 'Alpha'), s('b', 'Beta')]}
        onDecide={onDecide}
        onOpenSession={onOpen}
      />,
    );
    expect(screen.getByText('2 approvals pending')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Beta' }));
    expect(onOpen).toHaveBeenCalledWith('b');
    await userEvent.click(screen.getAllByRole('button', { name: 'Deny' })[0]!);
    expect(onDecide).toHaveBeenCalledWith('1', { kind: 'deny' });
  });

  it('renders nothing when there are no approvals', () => {
    const { container } = render(<ApprovalsDrawer approvals={[]} sessions={[]} onDecide={vi.fn()} onOpenSession={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });
});
```

- [ ] **Step 2: Run to verify failure** → `pnpm --filter @relay/desktop test ApprovalsDrawer` FAIL, module not found.

- [ ] **Step 3: Implementation**

```tsx
import type { ApprovalDecision, PendingApproval, SessionSummary } from '@relay/shared';
import { ApprovalCard } from './ApprovalCard';

interface Props {
  approvals: PendingApproval[];
  sessions: SessionSummary[];
  onDecide: (id: string, decision: ApprovalDecision) => void;
  onOpenSession: (id: string) => void;
}

/** Every pending approval across sessions; lives under the orchestrator column. */
export function ApprovalsDrawer({ approvals, sessions, onDecide, onOpenSession }: Props) {
  if (approvals.length === 0) return null;
  const title = (id: string) => sessions.find((s) => s.id === id)?.title ?? id;
  return (
    <aside className="approvals-drawer" aria-label="Approvals">
      <h2>{approvals.length} {approvals.length === 1 ? 'approval' : 'approvals'} pending</h2>
      {approvals.map((a) => (
        <div key={a.id} className="approvals-drawer__item">
          <button type="button" className="link" onClick={() => onOpenSession(a.sessionId)}>{title(a.sessionId)}</button>
          <ApprovalCard approval={a} onDecide={onDecide} />
        </div>
      ))}
    </aside>
  );
}
```

In `App.tsx`, inside `<main className="orchestrator">` after the placeholder:
```tsx
<ApprovalsDrawer approvals={run.approvals} sessions={sessions} onDecide={(id, d) => void window.relay.decide(id, d)} onOpenSession={setSelectedId} />
```
Styles:
```css
.approvals-drawer { position: sticky; bottom: 0; margin-top: auto; border-top: 1px solid #d98a00; padding-top: 8px; background: Canvas; }
.approvals-drawer h2 { font-size: 12px; margin: 0 0 8px; }
.link { background: none; border: 0; color: inherit; text-decoration: underline; cursor: pointer; padding: 0; margin-bottom: 4px; }
.orchestrator { display: flex; flex-direction: column; }
```

- [ ] **Step 4: Run, typecheck, commit**

Run: `pnpm --filter @relay/desktop test && pnpm typecheck` → PASS / Done.

```bash
git add apps/desktop
git commit -m "feat(desktop): global approvals drawer"
```

---

### Task 11: Manual verification against a real session, README

**Files:**
- Modify: `README.md`

No unit test can prove the SDK integration end to end; this task is the scripted manual check the spec's testing section calls for.

- [ ] **Step 1: Run against a scratch session**

1. In a scratch git repo (`mkdir -p /tmp/relay-scratch && cd /tmp/relay-scratch && git init -q && echo hi > a.txt && git add . && git commit -qm init`), run `claude` once, type `say hello and stop`, wait for the reply, then quit Claude Code. This leaves a transcript under `~/.claude/projects/-tmp-relay-scratch/`. Wait 20 s (the busy window).
2. `cd ~/code/relay-hub && pnpm dev`. Select the scratch session. Its state shows **idle**.
3. In the dev box, send `create b.txt containing "two" and commit it` with mode **steer**. Expected: state → **running**, live entries stream in with origin `user`, then **idle**. `git -C /tmp/relay-scratch log --oneline` shows the new commit.
4. Send `now force-push to origin` (there is no remote). Expected: an approval card appears in the panel and in the drawer, state → **waiting-approval**, a macOS notification fires. Click **Deny**. Expected: the agent reports it was denied, state → **idle**.
5. Send `count to 30 slowly, one number per line`, then while it runs send `stop counting and say done` with mode **interrupt**. Expected: the count stops early, the second instruction is answered, state → **idle**.
6. Re-open the same session in a terminal with `claude --resume <id>` and type anything; within 15 s try to send from Relay. Expected: the panel shows the "being written by another process" error and nothing is sent.

Record the outcome of each step in the commit message body. Any deviation is a bug: fix it with a failing test first (engine) or note it as a follow-up if it is SDK behaviour.

- [ ] **Step 2: README**

Add under "Run":
```
## Driving a session (M2)
Select a session and use the dev box at the bottom of its panel (dev builds only). Modes:
steer (now), queue (after the current turn), interrupt (abort, then send). Destructive git
commands and paths outside the session directory wait in the approvals drawer.
```

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: driving a session; manual M2 verification"
```

---

## Follow-ups not in this plan

- Partial (token-level) streaming: the SDK's `includePartialMessages` events are mapped to nothing in `SdkAgentClient`; add a `partial` `AgentMessage` when the panel needs typing-style output.
- Persisting approval decisions across app restarts: `allow-pattern` lives for the runner only, by spec.
- Serialising overlapping `SessionIndex` scans while a driven session writes its transcript quickly (M1 deferred minor; the busy window and entry merge keep the UI coherent meanwhile).
