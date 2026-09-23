# Relay Hub — Milestone 3: Orchestrator chat

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The middle column becomes a chat with an orchestrator agent that can list and inspect sessions, send them instructions, interrupt them, and hear back when a turn it started ends.

**Architecture:** The orchestrator is one more `SessionRunner`, keyed `orchestrator`, that starts a fresh SDK session the first time and resumes its stored id afterwards. It runs with no built-in tools. Its only tools are Relay operations, defined engine-side as `AgentTool`s and turned into an in-process MCP server by `SdkAgentClient`. A completion relay inside `RelayEngine` watches the other runners: when a turn the orchestrator caused ends, it queues a compact summary into the orchestrator.

**Tech Stack:** as M2, plus `zod` (already a peer dependency of the SDK; 4.x) for tool input schemas.

**Spec:** `docs/superpowers/specs/2026-09-23-relay-hub-design.md`, sections "Orchestrator tools", "Completion relay", "Targeted instruction", "Startup and restore".

## Global Constraints

- The orchestrator never runs shell or file tools: `tools: []`, `settingSources: []`. Its only way to change anything is through a session, where approvals live.
- M3 tools are `list_sessions`, `get_session`, `send_to_session`, `interrupt_session`. `propose_bulk_action` is M4; `list_prs` and watches are M5.
- System prompt rules (spec): name the target session in the reply before sending; ask when a target is ambiguous; never send to more than one session per request in M3. In M3 the orchestrator must ask the user to repeat the request per session, because bulk actions arrive in M4.
- The orchestrator's own sessions (cwd = the orchestrator directory) never appear in `listSessions()` and cannot be targeted.
- The orchestrator's session id is persisted in the Store (`meta` key `orchestrator.sessionId`) and resumed on the next start.
- Completion relay fires only for turns whose triggering send had origin `orchestrator`. The user's own dev-box sends never wake the orchestrator, so they spend no tokens. It is delivered with mode `queue` and origin `watch:turn-end`.
- `send_to_session` returns immediately with the send id; the result arrives later through the relay.
- Runner events for the orchestrator use the key `orchestrator` (`ORCHESTRATOR_KEY`) as `sessionId`.
- Commits end with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`. No ticket ids in code.

## Review Focus

1. **The orchestrator targets itself.** Its own transcript sits in `~/.claude/projects` like any other session. `list_sessions` must not show it and `send_to_session` must refuse it (Task 6, Task 7).
2. **A busy or unknown target.** `send_to_session` must return the engine's refusal (`open in another Claude process…`, `Unknown session…`) to the model as a tool error, never throw out of the MCP handler (Task 5).
3. **A relay storm.** A session the orchestrator drove may run several turns (a steer folded in, a queued follow-up). The relay must summarise each finished orchestrator-caused turn once, and not relay turns the user started from the dev box (Task 7).
4. **First start vs restart.** With no stored id the orchestrator starts a fresh session and stores the id from `init`. With a stored id it resumes. If the resume fails (the transcript was deleted), it clears the id and the next message starts fresh (Tasks 4, 6).
5. **Huge sessions in `get_session`.** The tool must cap what it returns (last 20 entries, 400 chars per text block, tool calls reduced to their name) so one call never floods the orchestrator's context (Task 5).

---

### Task 1: Shared contract

**Files:**
- Modify: `packages/shared/src/runner.ts`, `packages/shared/src/ipc.ts`, `packages/shared/src/index.ts`
- Modify: `apps/desktop/src/preload.ts`, `apps/desktop/src/ipc.ts`, `apps/desktop/src/ui/App.test.tsx` (stub new members only)

**Interfaces:**
- Produces:
  ```ts
  export const ORCHESTRATOR_KEY = 'orchestrator';
  IPC.orchestratorSend / orchestratorInterrupt / orchestratorHistory
  RelayApi.orchestratorSend(prompt: string): Promise<string>
  RelayApi.orchestratorInterrupt(): Promise<void>
  RelayApi.orchestratorHistory(): Promise<TranscriptEntry[]>
  ```

- [ ] **Step 1:** In `runner.ts` add
```ts
/** `sessionId` used by runner events that belong to the orchestrator itself. */
export const ORCHESTRATOR_KEY = 'orchestrator';
```
and export it from `index.ts` as a value (`export { ORCHESTRATOR_KEY } from './runner';`).

- [ ] **Step 2:** In `ipc.ts` add channels `orchestratorSend: 'relay:orchestratorSend'`, `orchestratorInterrupt: 'relay:orchestratorInterrupt'`, `orchestratorHistory: 'relay:orchestratorHistory'`, and the three `RelayApi` members above.

- [ ] **Step 3 (red):** `pnpm typecheck` → FAIL in `preload.ts` and `App.test.tsx` (missing members).

- [ ] **Step 4:** Implement in `preload.ts`:
```ts
  orchestratorSend: (prompt) => ipcRenderer.invoke(IPC.orchestratorSend, prompt),
  orchestratorInterrupt: () => ipcRenderer.invoke(IPC.orchestratorInterrupt),
  orchestratorHistory: () => ipcRenderer.invoke(IPC.orchestratorHistory),
```
In `App.test.tsx`'s fake add `orchestratorSend: vi.fn().mockResolvedValue('o-1'), orchestratorInterrupt: vi.fn().mockResolvedValue(undefined), orchestratorHistory: vi.fn().mockResolvedValue([])`. The main-process handlers come in Task 8, after the engine methods exist.

- [ ] **Step 5:** `pnpm typecheck && pnpm test` → green. Commit `feat(shared): orchestrator IPC contract`.

---

### Task 2: Store metadata

**Files:** Modify `packages/engine/src/store/session-store.ts`; test `packages/engine/test/store/session-store.test.ts`.

**Interfaces:** Produces `SessionStore.getMeta(key: string): string | null`, `SessionStore.setMeta(key: string, value: string | null): void` (null deletes).

- [ ] **Step 1 (red):** add to the test file:
```ts
  it('stores, overwrites and deletes metadata values', () => {
    const store = new SessionStore(':memory:');
    expect(store.getMeta('orchestrator.sessionId')).toBeNull();
    store.setMeta('orchestrator.sessionId', 'a');
    store.setMeta('orchestrator.sessionId', 'b');
    expect(store.getMeta('orchestrator.sessionId')).toBe('b');
    store.setMeta('orchestrator.sessionId', null);
    expect(store.getMeta('orchestrator.sessionId')).toBeNull();
  });

  it('keeps metadata across reopen of the same file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'relay-store-'));
    const path = join(dir, 'relay.db');
    const a = new SessionStore(path);
    a.setMeta('k', 'v');
    a.close();
    const b = new SessionStore(path);
    expect(b.getMeta('k')).toBe('v');
    b.close();
    await rm(dir, { recursive: true, force: true });
  });
```
(imports: `mkdtemp`, `rm` from `node:fs/promises`, `tmpdir` from `node:os`, `join` from `node:path`.) Run `pnpm --filter @relay/engine test session-store` → FAIL (`getMeta` not a function).

- [ ] **Step 2:** In the constructor's `exec` add `create table if not exists meta (key text primary key, value text not null);` and:
```ts
  getMeta(key: string): string | null {
    const row = this.db.prepare('select value from meta where key = ?').get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  /** `null` deletes the key. */
  setMeta(key: string, value: string | null): void {
    if (value === null) this.db.prepare('delete from meta where key = ?').run(key);
    else this.db.prepare('insert into meta (key, value) values (?, ?) on conflict(key) do update set value = excluded.value').run(key, value);
  }
```
- [ ] **Step 3:** test → PASS. Commit `feat(engine): metadata key-values in the store`.

---

### Task 3: AgentClient — fresh sessions, tools and a system prompt

**Files:** Modify `packages/engine/src/runner/agent-client.ts`, `packages/engine/src/runner/sdk-agent-client.ts`, `packages/engine/test/runner/fake-agent-client.ts`; test `packages/engine/test/runner/sdk-agent-client.test.ts`.

**Interfaces:**
- Produces:
  ```ts
  interface AgentTool<Shape extends ZodRawShape = ZodRawShape> {
    name: string; description: string; input: Shape;
    handler: (args: z.infer<z.ZodObject<Shape>>) => Promise<AgentToolResult>;
  }
  type AgentToolResult = { text: string; isError?: boolean };
  interface AgentStartOptions {
    sessionId: string | null;     // null → start a fresh session
    cwd: string;
    input: AsyncIterable<AgentInput>;
    canUseTool: CanUseToolFn;
    profile?: { kind: 'session' } | { kind: 'orchestrator'; systemPrompt: string; tools: AgentTool[] };
  }
  ```
  With `profile.kind === 'orchestrator'`, `SdkAgentClient` passes `tools: []`, `settingSources: []`, `systemPrompt`, `mcpServers: { relay: createSdkMcpServer({ name: 'relay', tools }) }` and `allowedTools: tools.map((t) => \`mcp__relay__${t.name}\`)`, and no `resume` when `sessionId` is null. The session profile (default) stays exactly as in M2.

- [ ] **Step 1 (red):** add to `sdk-agent-client.test.ts`:
```ts
  it('starts an orchestrator: no resume, no built-in tools, only Relay tools over in-process MCP', async () => {
    let seen: Parameters<SdkQueryFn>[0] | null = null;
    const fakeQuery = ((params: Parameters<SdkQueryFn>[0]) => {
      seen = params;
      async function* gen() {}
      const g = gen() as FakeGen;
      g.interrupt = async () => undefined;
      return g;
    }) as unknown as SdkQueryFn;
    const echo: AgentTool = {
      name: 'echo',
      description: 'Echo',
      input: { text: z.string() },
      handler: async (args) => ({ text: String(args.text) }),
    };
    const run = new SdkAgentClient(fakeQuery).start({
      sessionId: null,
      cwd: '/orch',
      input: new AsyncQueue(),
      canUseTool: async () => ({ behavior: 'allow' }),
      profile: { kind: 'orchestrator', systemPrompt: 'You route.', tools: [echo] },
    });
    await collect(run.messages);
    const o = seen!.options!;
    expect(o.resume).toBeUndefined();
    expect(o).toMatchObject({ cwd: '/orch', tools: [], settingSources: [], systemPrompt: 'You route.', allowedTools: ['mcp__relay__echo'] });
    expect(Object.keys(o.mcpServers ?? {})).toEqual(['relay']);
  });
```
(imports: `z` from `zod`, `AgentTool` type from `../../src/runner/agent-client`.) Also change every existing `start({ sessionId: '…' …})` call in that file: they keep working because `sessionId` stays a string there. Run → FAIL (typecheck / `resume` defined, `tools` missing).

- [ ] **Step 2:** `pnpm --filter @relay/engine add zod@^4` (same major the SDK peers on). Update `agent-client.ts`:
```ts
import type { z, ZodRawShape } from 'zod';

export type AgentToolResult = { text: string; isError?: boolean };

/** A tool the agent can call that runs inside Relay's process. */
export interface AgentTool<Shape extends ZodRawShape = ZodRawShape> {
  name: string;
  description: string;
  input: Shape;
  handler: (args: z.infer<z.ZodObject<Shape>>) => Promise<AgentToolResult>;
}

export type AgentProfile =
  | { kind: 'session' }
  | { kind: 'orchestrator'; systemPrompt: string; tools: AgentTool[] };
```
Change `AgentStartOptions.sessionId` to `string | null` with the doc `/** null starts a fresh session. */` and add `profile?: AgentProfile`.

- [ ] **Step 3:** In `sdk-agent-client.ts` build options by profile:
```ts
import { createSdkMcpServer, query as sdkQuery, tool, type Options, ... } from '@anthropic-ai/claude-agent-sdk';

function profileOptions(opts: AgentStartOptions): Options {
  const base: Options = { cwd: opts.cwd, ...(opts.sessionId ? { resume: opts.sessionId } : {}) };
  const profile = opts.profile ?? { kind: 'session' };
  if (profile.kind === 'session') {
    // Project settings and CLAUDE.md load; user/local permission allow-lists must not
    // pre-approve commands before Relay's own approval rules see them.
    return { ...base, permissionMode: 'acceptEdits', settingSources: ['project'] };
  }
  const server = createSdkMcpServer({
    name: 'relay',
    tools: profile.tools.map((t) =>
      tool(t.name, t.description, t.input, async (args) => {
        const r = await t.handler(args as never);
        return { content: [{ type: 'text', text: r.text }], isError: r.isError === true };
      }),
    ),
  });
  return {
    ...base,
    tools: [],
    settingSources: [],
    systemPrompt: profile.systemPrompt,
    mcpServers: { relay: server },
    allowedTools: profile.tools.map((t) => `mcp__relay__${t.name}`),
  };
}
```
and in `start` spread `...profileOptions(opts)` in place of the fixed `resume/cwd/permissionMode/settingSources` keys, keeping `canUseTool`. (`args as never` is the one cast: the zod generic is erased at the `tool()` boundary.)

- [ ] **Step 4:** In `fake-agent-client.ts` nothing changes except the type of `starts` (still `AgentStartOptions[]`). Add a helper for later tasks:
```ts
  /** Calls a tool the orchestrator was started with, as the model would. */
  callTool(name: string, args: Record<string, unknown>) {
    const profile = this.lastOpts?.profile;
    if (profile?.kind !== 'orchestrator') throw new Error('not an orchestrator run');
    const t = profile.tools.find((x) => x.name === name);
    if (!t) throw new Error(`no tool ${name}`);
    return t.handler(args as never);
  }
```
- [ ] **Step 5:** `pnpm --filter @relay/engine test && pnpm typecheck` → green (`SessionRunner` still passes a string id). Commit `feat(engine): agent profiles — orchestrator runs with Relay tools only`.

---

### Task 4: SessionRunner — fresh sessions, session id, user entries

**Files:** Modify `packages/engine/src/runner/session-runner.ts`; test `packages/engine/test/runner/session-runner.test.ts`.

**Interfaces:**
- Produces:
  ```ts
  interface SessionRunnerOptions { ...; resume?: string | null; profile?: AgentProfile }   // resume defaults to sessionId
  RunnerEvents += { 'session-id': [string]; 'turn-end': [{ origins: MessageOrigin[]; lastText: string | null; error: string | null }] }
  ```
  - `resume: null` starts fresh; the `init` message's id is emitted as `session-id` and used as `resume` for any later restart of the run.
  - Every `send` emits a `user` `LiveEntry` right away (uuid = send id, one text block, origin). The prompt then shows at once in the panel and chat instead of after the file refetch. The file line carries the same uuid, because the id rides as the SDK message uuid, so the merge dedupes it.
  - `turn-end` fires when the runner settles to `idle` or `error`. It carries the origins of the sends that turn settled and the last assistant text seen since the previous turn-end.

- [ ] **Step 1 (red):** add tests:
```ts
  it('with resume null starts fresh, reports the new session id and resumes it after an error', async () => {
    const client = new FakeAgentClient();
    const approvals = new ApprovalQueue();
    const runner = new SessionRunner({ sessionId: 'orchestrator', resume: null, cwd: '/o', client, approvals });
    const ids: string[] = [];
    runner.on('session-id', (id) => ids.push(id));
    await runner.send('hi', { mode: 'steer', origin: 'user' });
    await tick();
    expect(client.starts[0]?.sessionId).toBeNull();
    client.init('new-123');
    client.result('boom');
    await tick();
    expect(ids).toEqual(['new-123']);
    await runner.send('again', { mode: 'steer', origin: 'user' });
    await tick();
    expect(client.starts[1]?.sessionId).toBe('new-123');
  });

  it('emits the user prompt as a live entry at once', async () => {
    const { runner, entries } = setup();
    const id = await runner.send('do x', { mode: 'steer', origin: 'orchestrator' });
    expect(entries[0]).toMatchObject({ uuid: id, role: 'user', origin: 'orchestrator', blocks: [{ kind: 'text', text: 'do x' }] });
  });

  it('turn-end carries the settled origins and the last assistant text', async () => {
    const { client, runner } = setup();
    const ends: unknown[] = [];
    runner.on('turn-end', (e) => ends.push(e));
    await runner.send('a', { mode: 'steer', origin: 'orchestrator' });
    await tick();
    client.assistant('a1', 'first');
    client.assistant('a2', 'final answer');
    client.result();
    await tick();
    expect(ends).toEqual([{ origins: ['orchestrator'], lastText: 'final answer', error: null }]);
  });

  it('turn-end on error carries the reason', async () => {
    const { client, runner } = setup();
    const ends: unknown[] = [];
    runner.on('turn-end', (e) => ends.push(e));
    await runner.send('a', { mode: 'steer', origin: 'orchestrator' });
    await tick();
    client.result('api error');
    await tick();
    expect(ends).toEqual([{ origins: ['orchestrator'], lastText: null, error: 'api error' }]);
  });
```
Add to `FakeAgentClient`: `init(sessionId: string) { this.out.push({ type: 'init', sessionId }); }`. Update the existing first test's `entries` expectation: it now starts with the user entry, so assert `entries.map((e) => e.role)` equals `['user', 'assistant']` and the assistant one has origin `orchestrator`. Run → FAIL.

- [ ] **Step 2:** Implementation in `session-runner.ts`:
  - options: `resume?: string | null`, `profile?: AgentProfile`; field `private resumeId: string | null` = `opts.resume === undefined ? opts.sessionId : opts.resume`.
  - `startRun` passes `sessionId: this.resumeId, profile: this.profile`.
  - `consume` on `init`: if `m.sessionId !== this.resumeId` then `this.resumeId = m.sessionId; this.emit('session-id', m.sessionId)`.
  - keep `private readonly originsById = new Map<string, MessageOrigin>()` set in `send`; `private lastText: string | null = null` updated on each assistant entry to the joined text blocks (if any text).
  - `send` emits `{ uuid: id, role: 'user', timestamp: new Date().toISOString(), isSidechain: false, isMeta: false, blocks: [{ kind: 'text', text: prompt }], origin }` before pushing input.
  - `settleTurn` collects the origins of the ids it removes from `outstanding`, including those removed by the `clear()` branch and the `aborting` branch. When the state becomes `idle` it emits `turn-end` with `{ origins, lastText, error: null }` and resets `lastText`.
  - `fail` emits `turn-end` with the origins of everything outstanding, `lastText` and `error: reason`.
  - add `get resumeSessionId(): string | null`.
  - `SessionRunnerEvents` type: `{ state: [SessionState, string | null]; entry: [LiveEntry]; 'session-id': [string]; 'turn-end': [TurnEnd] }` with `export interface TurnEnd { origins: MessageOrigin[]; lastText: string | null; error: string | null }`.
- [ ] **Step 3:** `pnpm --filter @relay/engine test` → green; typecheck. Commit `feat(engine): runners can start fresh sessions and report turn ends`.

---

### Task 5: Relay tools

**Files:** Create `packages/engine/src/orchestrator/relay-tools.ts`; test `packages/engine/test/orchestrator/relay-tools.test.ts`.

**Interfaces:**
- Consumes: `AgentTool`, `SessionSummary`, `TranscriptEntry`, `RunState`, `PendingApproval`.
- Produces:
  ```ts
  interface RelayToolDeps {
    listSessions(): SessionSummary[];
    runState(): RunState;
    getTranscript(id: string): Promise<TranscriptEntry[]>;
    send(req: { sessionId: string; prompt: string; mode: DeliveryMode; origin: 'orchestrator' }): Promise<string>;
    interrupt(sessionId: string): Promise<void>;
  }
  function createRelayTools(deps: RelayToolDeps): AgentTool[]   // list_sessions, get_session, send_to_session, interrupt_session
  ```

Tool behaviour:
- `list_sessions({ query?, includeStale? })` returns JSON rows `{ id, repo, branch, title, state, lastActivity, prNumber, pendingApprovals }`. It matches `query` case-insensitively against title, branch and repo, hides stale sessions unless `includeStale`, sorts newest first, and caps at 50 rows. Reuse the filter from the renderer's `groupSessions`? No: that lives in `apps/desktop`, and the engine can't import it. The logic is three lines, so this is deliberate duplication, noted in the file.
- `get_session({ id })` returns summary + state + pending approvals + `recent`: the last 20 non-meta, non-sidechain entries. Text blocks are truncated to 400 chars, tool_use becomes `{tool: name}`, and tool_result becomes `{result: first 200 chars}`. An unknown id gives `isError`.
- `send_to_session({ id, prompt, mode? })` defaults `mode` to `steer` and returns `{ sent: true, messageId, note: 'You will get a turn-end message when it finishes.' }`. Any thrown error becomes `{ text: error.message, isError: true }`.
- `interrupt_session({ id })` returns `{ interrupted: true }`; errors become `isError`.

- [ ] **Step 1 (red):** test file:
```ts
import { describe, expect, it, vi } from 'vitest';
import type { SessionSummary, TranscriptEntry } from '@relay/shared';
import { createRelayTools, type RelayToolDeps } from '../../src/orchestrator/relay-tools';

const s = (over: Partial<SessionSummary>): SessionSummary => ({
  id: 'x', filePath: '/f', cwd: '/c', cwdExists: true, repo: 'repo', branch: 'main', title: 'T',
  lastActivity: '2026-09-20T00:00:00.000Z', messageCount: 1, prNumber: null, prUrl: null, continuedIn: null,
  isStale: false, ...over,
});

function deps(over: Partial<RelayToolDeps> = {}): RelayToolDeps {
  return {
    listSessions: () => [
      s({ id: 'a', title: 'Mileage claims', branch: 'feat/mileage', lastActivity: '2026-09-22T00:00:00.000Z', prNumber: 12 }),
      s({ id: 'b', title: 'OCR ideas', lastActivity: '2026-09-21T00:00:00.000Z' }),
      s({ id: 'c', title: 'Old', isStale: true }),
    ],
    runState: () => ({ states: { a: { state: 'running', error: null } }, approvals: [] }),
    getTranscript: async () => [],
    send: vi.fn(async () => 'm-1'),
    interrupt: vi.fn(async () => undefined),
    ...over,
  };
}

const call = async (d: RelayToolDeps, name: string, args: Record<string, unknown>) => {
  const t = createRelayTools(d).find((x) => x.name === name)!;
  return t.handler(args as never);
};

describe('relay tools', () => {
  it('exposes exactly the M3 tools', () => {
    expect(createRelayTools(deps()).map((t) => t.name)).toEqual([
      'list_sessions', 'get_session', 'send_to_session', 'interrupt_session',
    ]);
  });

  it('list_sessions filters, hides stale, sorts newest first and includes run state', async () => {
    const all = JSON.parse((await call(deps(), 'list_sessions', {})).text);
    expect(all.map((r: { id: string }) => r.id)).toEqual(['a', 'b']);
    expect(all[0]).toEqual({
      id: 'a', repo: 'repo', branch: 'feat/mileage', title: 'Mileage claims', state: 'running',
      lastActivity: '2026-09-22T00:00:00.000Z', prNumber: 12, pendingApprovals: 0,
    });
    const found = JSON.parse((await call(deps(), 'list_sessions', { query: 'MILEAGE' })).text);
    expect(found.map((r: { id: string }) => r.id)).toEqual(['a']);
    const withStale = JSON.parse((await call(deps(), 'list_sessions', { includeStale: true })).text);
    expect(withStale).toHaveLength(3);
  });

  it('get_session caps recent entries and truncates their content', async () => {
    const long = 'y'.repeat(1000);
    const entries: TranscriptEntry[] = Array.from({ length: 30 }, (_, i) => ({
      uuid: `e${i}`, role: i % 2 ? 'assistant' : 'user', timestamp: '2026-09-22T00:00:00.000Z',
      isSidechain: false, isMeta: false,
      blocks: [{ kind: 'text', text: long }, { kind: 'tool_use', id: 't', name: 'Bash', input: { command: 'ls' } }],
    }));
    const r = JSON.parse((await call(deps({ getTranscript: async () => entries }), 'get_session', { id: 'a' })).text);
    expect(r.session).toMatchObject({ id: 'a', title: 'Mileage claims', state: 'running' });
    expect(r.recent).toHaveLength(20);
    expect(r.recent[0].content[0]).toHaveLength(401); // 400 + ellipsis
    expect(r.recent[0].content[1]).toEqual({ tool: 'Bash' });
  });

  it('get_session reports an unknown id as a tool error', async () => {
    expect(await call(deps(), 'get_session', { id: 'nope' })).toMatchObject({ isError: true });
  });

  it('send_to_session sends with origin orchestrator, steer by default, and returns the message id', async () => {
    const d = deps();
    const r = await call(d, 'send_to_session', { id: 'a', prompt: 'add tests' });
    expect(d.send).toHaveBeenCalledWith({ sessionId: 'a', prompt: 'add tests', mode: 'steer', origin: 'orchestrator' });
    expect(JSON.parse(r.text)).toMatchObject({ sent: true, messageId: 'm-1' });
  });

  it('send_to_session turns an engine refusal into a tool error the model can read', async () => {
    const d = deps({ send: async () => { throw new Error('Session a is open in another Claude process (pid 7)'); } });
    expect(await call(d, 'send_to_session', { id: 'a', prompt: 'x' })).toEqual({
      text: 'Session a is open in another Claude process (pid 7)', isError: true,
    });
  });

  it('interrupt_session interrupts and reports errors as tool errors', async () => {
    const d = deps();
    expect(JSON.parse((await call(d, 'interrupt_session', { id: 'a' })).text)).toEqual({ interrupted: true });
    expect(d.interrupt).toHaveBeenCalledWith('a');
    const bad = deps({ interrupt: async () => { throw new Error('nope'); } });
    expect(await call(bad, 'interrupt_session', { id: 'a' })).toEqual({ text: 'nope', isError: true });
  });
});
```
Run → FAIL (module not found).

- [ ] **Step 2:** Implementation:
```ts
import { z } from 'zod';
import type { DeliveryMode, SessionSummary, TranscriptBlock, TranscriptEntry, RunState } from '@relay/shared';
import type { AgentTool, AgentToolResult } from '../runner/agent-client';

const LIST_MAX = 50;
const RECENT_MAX = 20;
const TEXT_MAX = 400;
const RESULT_MAX = 200;

export interface RelayToolDeps {
  listSessions(): SessionSummary[];
  runState(): RunState;
  getTranscript(id: string): Promise<TranscriptEntry[]>;
  send(req: { sessionId: string; prompt: string; mode: DeliveryMode; origin: 'orchestrator' }): Promise<string>;
  interrupt(sessionId: string): Promise<void>;
}

const ok = (value: unknown): AgentToolResult => ({ text: JSON.stringify(value) });
const fail = (err: unknown): AgentToolResult => ({ text: err instanceof Error ? err.message : String(err), isError: true });
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);

function row(s: SessionSummary, run: RunState) {
  return {
    id: s.id, repo: s.repo, branch: s.branch, title: s.title,
    state: run.states[s.id]?.state ?? 'idle',
    lastActivity: s.lastActivity, prNumber: s.prNumber,
    pendingApprovals: run.approvals.filter((a) => a.sessionId === s.id).length,
  };
}

function compact(block: TranscriptBlock): unknown {
  switch (block.kind) {
    case 'text': return clip(block.text, TEXT_MAX);
    case 'tool_use': return { tool: block.name };
    case 'tool_result': return { result: clip(block.text, RESULT_MAX) };
    default: return null;
  }
}

/** The orchestrator's whole world: read sessions, send to one, interrupt one. */
export function createRelayTools(deps: RelayToolDeps): AgentTool[] {
  const find = (id: string) => deps.listSessions().find((s) => s.id === id);
  const listSessions: AgentTool<{ query: z.ZodOptional<z.ZodString>; includeStale: z.ZodOptional<z.ZodBoolean> }> = {
    name: 'list_sessions',
    description: 'List Claude Code sessions on this machine, newest first. Optional case-insensitive query over title, branch and repo.',
    input: { query: z.string().optional(), includeStale: z.boolean().optional() },
    handler: async ({ query, includeStale }) => {
      const q = (query ?? '').trim().toLowerCase();
      const run = deps.runState();
      // Same matching as the sidebar's groupSessions (apps/desktop); duplicated because the engine cannot import the app.
      const rows = deps
        .listSessions()
        .filter((s) => (includeStale || !s.isStale) && (q === '' || [s.title, s.branch ?? '', s.repo].some((f) => f.toLowerCase().includes(q))))
        .sort((a, b) => b.lastActivity.localeCompare(a.lastActivity))
        .slice(0, LIST_MAX)
        .map((s) => row(s, run));
      return ok(rows);
    },
  };
  ...
  return [listSessions, getSession, sendToSession, interruptSession] as AgentTool[];
}
```
Write `getSession` (`{ id: z.string() }`), `sendToSession` (`{ id: z.string(), prompt: z.string(), mode: z.enum(['steer', 'queue', 'interrupt']).optional() }`) and `interruptSession` (`{ id: z.string() }`) the same way, following the behaviour list above. Each handler wraps its body in `try { … } catch (err) { return fail(err); }`. The final `as AgentTool[]` widens the per-tool shapes into the array type.
- [ ] **Step 3:** test → PASS; typecheck. Commit `feat(engine): relay tools for the orchestrator`.

---

### Task 6: Orchestrator

**Files:** Create `packages/engine/src/orchestrator/orchestrator.ts`, `packages/engine/src/orchestrator/system-prompt.ts`; test `packages/engine/test/orchestrator/orchestrator.test.ts`.

**Interfaces:**
- Consumes: `SessionRunner` (Task 4), `SessionStore.getMeta/setMeta` (Task 2), `createRelayTools` (Task 5).
- Produces:
  ```ts
  class Orchestrator extends EventEmitter<{ state: [SessionState, string | null]; entry: [LiveEntry] }> {
    constructor(opts: { cwd: string; client: AgentClient; approvals: ApprovalQueue; store: SessionStore; tools: AgentTool[] })
    send(prompt: string, opts?: { origin?: MessageOrigin; mode?: DeliveryMode }): Promise<string>  // default user / steer
    interrupt(): Promise<void>
    get sessionId(): string | null
    get state(): SessionState
    close(): Promise<void>
  }
  const ORCHESTRATOR_SYSTEM_PROMPT: string
  ```
  The id is stored under meta `orchestrator.sessionId` on `session-id`. When a turn ends in error and the stored id was used for resume, the id is cleared, so the next send starts fresh.

- [ ] **Step 1 (red):**
```ts
import { describe, expect, it } from 'vitest';
import { ApprovalQueue } from '../../src/approvals/approval-queue';
import { Orchestrator } from '../../src/orchestrator/orchestrator';
import { SessionStore } from '../../src/store/session-store';
import { FakeAgentClient, tick } from '../runner/fake-agent-client';

function setup(storedId: string | null = null) {
  const client = new FakeAgentClient();
  const store = new SessionStore(':memory:');
  if (storedId) store.setMeta('orchestrator.sessionId', storedId);
  const o = new Orchestrator({ cwd: '/orch', client, approvals: new ApprovalQueue(), store, tools: [] });
  return { client, store, o };
}

describe('Orchestrator', () => {
  it('starts fresh the first time and stores the new session id', async () => {
    const { client, store, o } = setup();
    await o.send('hello');
    await tick();
    expect(client.starts[0]).toMatchObject({ sessionId: null, cwd: '/orch', profile: { kind: 'orchestrator' } });
    client.init('orch-1');
    await tick();
    expect(store.getMeta('orchestrator.sessionId')).toBe('orch-1');
    expect(o.sessionId).toBe('orch-1');
  });

  it('resumes the stored session id', async () => {
    const { client, o } = setup('orch-9');
    await o.send('hello');
    await tick();
    expect(client.starts[0]?.sessionId).toBe('orch-9');
  });

  it('forgets a stored id whose resume failed, so the next send starts fresh', async () => {
    const { client, store, o } = setup('gone');
    await o.send('hello');
    await tick();
    client.result('error_during_execution: No conversation found');
    await tick();
    expect(store.getMeta('orchestrator.sessionId')).toBeNull();
    await o.send('again');
    await tick();
    expect(client.starts[1]?.sessionId).toBeNull();
  });

  it('passes its tools and system prompt in the orchestrator profile', async () => {
    const client = new FakeAgentClient();
    const tools = [{ name: 't', description: 'd', input: {}, handler: async () => ({ text: '' }) }];
    const o = new Orchestrator({ cwd: '/o', client, approvals: new ApprovalQueue(), store: new SessionStore(':memory:'), tools });
    await o.send('x');
    await tick();
    const profile = client.starts[0]?.profile;
    expect(profile?.kind).toBe('orchestrator');
    expect(profile?.kind === 'orchestrator' && profile.tools).toBe(tools);
    expect(profile?.kind === 'orchestrator' && profile.systemPrompt.length).toBeGreaterThan(0);
  });
});
```
Run → FAIL.

- [ ] **Step 2:** `system-prompt.ts`:
```ts
/** The orchestrator's instructions; behaviour is checked through scenarios, not by testing this text. */
export const ORCHESTRATOR_SYSTEM_PROMPT = `You are Relay, an orchestrator for the user's Claude Code sessions on this machine.
You cannot read files or run commands yourself. You act only through your tools:
list_sessions, get_session, send_to_session and interrupt_session.

How to work:
- To find a session, call list_sessions (use its query) and, if needed, get_session.
- Before sending, say in one line which session you are sending to (title and branch) and what you will tell it.
- If more than one session could match, list the candidates and ask the user which one. Never guess.
- Send to one session per request. If the user asks for many at once, explain that bulk actions are not available yet and offer to do them one by one.
- Write the prompt for the session as a complete instruction, since that session has not seen this conversation.
- send_to_session returns at once. When the session finishes, you will receive a message that starts with "[turn-end]". Report its outcome to the user in one or two sentences.
- If a tool returns an error (for example the session is open in another Claude process), tell the user plainly and suggest what to do.
- Keep replies short.`;
```
`orchestrator.ts`:
```ts
import { EventEmitter } from 'node:events';
import { ORCHESTRATOR_KEY, type DeliveryMode, type LiveEntry, type MessageOrigin, type SessionState } from '@relay/shared';
import type { ApprovalQueue } from '../approvals/approval-queue';
import type { AgentClient, AgentTool } from '../runner/agent-client';
import { SessionRunner } from '../runner/session-runner';
import type { SessionStore } from '../store/session-store';
import { ORCHESTRATOR_SYSTEM_PROMPT } from './system-prompt';

const SESSION_ID_KEY = 'orchestrator.sessionId';

export interface OrchestratorOptions {
  cwd: string;
  client: AgentClient;
  approvals: ApprovalQueue;
  store: SessionStore;
  tools: AgentTool[];
}

type OrchestratorEvents = { state: [SessionState, string | null]; entry: [LiveEntry] };

/** The chat agent in the middle column: a runner with Relay's tools and a remembered session. */
export class Orchestrator extends EventEmitter<OrchestratorEvents> {
  private readonly runner: SessionRunner;
  private readonly store: SessionStore;
  private startedFrom: string | null;

  constructor(opts: OrchestratorOptions) {
    super();
    this.store = opts.store;
    this.startedFrom = opts.store.getMeta(SESSION_ID_KEY);
    this.runner = new SessionRunner({
      sessionId: ORCHESTRATOR_KEY,
      resume: this.startedFrom,
      cwd: opts.cwd,
      client: opts.client,
      approvals: opts.approvals,
      profile: { kind: 'orchestrator', systemPrompt: ORCHESTRATOR_SYSTEM_PROMPT, tools: opts.tools },
    });
    this.runner.on('session-id', (id) => this.store.setMeta(SESSION_ID_KEY, id));
    this.runner.on('state', (s, e) => this.emit('state', s, e));
    this.runner.on('entry', (e) => this.emit('entry', e));
    this.runner.on('turn-end', ({ error }) => {
      // A resume of a transcript that no longer exists fails every time; start over instead.
      if (error && this.startedFrom && this.runner.resumeSessionId === this.startedFrom) {
        this.store.setMeta(SESSION_ID_KEY, null);
        this.runner.resetSession();
        this.startedFrom = null;
      }
    });
  }

  get sessionId(): string | null {
    return this.runner.resumeSessionId;
  }

  get state(): SessionState {
    return this.runner.state;
  }

  send(prompt: string, opts: { origin?: MessageOrigin; mode?: DeliveryMode } = {}): Promise<string> {
    return this.runner.send(prompt, { mode: opts.mode ?? 'steer', origin: opts.origin ?? 'user' });
  }

  interrupt(): Promise<void> {
    return this.runner.interrupt();
  }

  close(): Promise<void> {
    return this.runner.close();
  }
}
```
Add to `SessionRunner`: `/** Forget the session id so the next run starts a fresh session. */ resetSession(): void { this.resumeId = null; }`, plus a test in `session-runner.test.ts`: after `resetSession()` and an error, the next send starts with `sessionId: null`.
- [ ] **Step 3:** tests → PASS. Commit `feat(engine): orchestrator with a remembered session`.

---

### Task 7: RelayEngine integration and completion relay

**Files:** Modify `packages/engine/src/relay-engine.ts`, `packages/engine/src/index.ts`; test `packages/engine/test/relay-engine.test.ts`.

**Interfaces:**
- Produces:
  ```ts
  RelayEngineOptions += { orchestratorDir: string }          // required; created if missing
  RelayEngine.orchestratorSend(prompt: string): Promise<string>
  RelayEngine.orchestratorInterrupt(): Promise<void>
  RelayEngine.orchestratorHistory(): Promise<TranscriptEntry[]>   // [] until it has a session
  ```
  - `listSessions()` excludes sessions whose `cwd` equals `orchestratorDir` (resolved), and `send` to one throws `Unknown session`.
  - Orchestrator `state`/`entry` are published as `RunnerEvent`s with `sessionId: ORCHESTRATOR_KEY`. Its approvals, which don't happen with its tools, still go through the shared queue.
  - Completion relay: for each session runner, on `turn-end` with `origins.includes('orchestrator')`, call `orchestrator.send(summary, { origin: 'watch:turn-end', mode: 'queue' })` with the summary
    `[turn-end] session "<title>" (<id>, <branch>) finished` + (error ? ` with an error: <error>` : `. Last reply: <lastText clipped to 600 chars, or "(no text)">`).
  - `orchestratorHistory()` reads the transcript of `orchestrator.sessionId` from the index. The index still sees the orchestrator's sessions, because only `listSessions()` filters them. It returns `[]` when there is no id yet or the file isn't indexed yet.
  - `close()` closes the orchestrator too.

- [ ] **Step 1 (red):** extend `startWithBasic` so that `RelayEngine.start` receives `orchestratorDir: join(root, 'orch')`. Also add `orchestratorDir: join(root, 'orch')` to the first test's own `start` call. Then add:
```ts
  it('hides the orchestrator\'s own sessions from the list and from send', async () => {
    const client = new FakeAgentClient();
    await startWithBasic(client);
    const orchDir = join(root, 'orch');
    const own = join(root, 'projects', 'orch-proj');
    await mkdir(own, { recursive: true });
    const src = await readFile(fixture('basic.jsonl'), 'utf8');
    await writeFile(join(own, 'o-1.jsonl'), src.replaceAll('/repo/wt-a', orchDir).replaceAll('s-basic', 'o-1'));
    await engine!['index'].scan();
    expect(engine!.listSessions().map((s) => s.id)).toEqual(['s-basic']);
    await expect(engine!.send({ sessionId: 'o-1', prompt: 'x', mode: 'steer', origin: 'user' })).rejects.toThrow(/unknown session/i);
  });

  it('routes orchestrator messages and publishes its events under the orchestrator key', async () => {
    const client = new FakeAgentClient();
    await startWithBasic(client);
    const events: RunnerEvent[] = [];
    engine!.onEvent((e) => events.push(e));
    await engine!.orchestratorSend('what is running?');
    await tick();
    expect(client.starts[0]).toMatchObject({ sessionId: null, cwd: join(root, 'orch'), profile: { kind: 'orchestrator' } });
    expect(events[0]).toMatchObject({ type: 'entry', sessionId: 'orchestrator', entry: { role: 'user' } });
  });

  it('relays the end of a turn the orchestrator started, and only those', async () => {
    const orchClient = new FakeAgentClient();
    const sessionClient = new FakeAgentClient();
    const router: AgentClient = {
      start: (opts) => (opts.profile?.kind === 'orchestrator' ? orchClient : sessionClient).start(opts),
    };
    await startWithBasic(router as FakeAgentClient);
    // the orchestrator calls send_to_session
    await engine!.orchestratorSend('tell s-basic to add tests');
    await tick();
    const r = await orchClient.callTool('send_to_session', { id: 's-basic', prompt: 'add tests' });
    expect(r.isError).toBeFalsy();
    await tick();
    sessionClient.assistant('a1', 'Added 3 tests.');
    sessionClient.result();
    await tick();
    const relayed = orchClient.received.filter((m) => m.origin === 'watch:turn-end');
    expect(relayed).toHaveLength(1);
    expect(relayed[0]).toMatchObject({ priority: 'next' });
    expect(relayed[0]!.text).toContain('[turn-end] session "Add tests for the zero-rate case" (s-basic, feat/a) finished. Last reply: Added 3 tests.');
    // a user dev-box send to the same session does not wake the orchestrator
    await engine!.send({ sessionId: 's-basic', prompt: 'more', mode: 'steer', origin: 'user' });
    await tick();
    sessionClient.result();
    await tick();
    expect(orchClient.received.filter((m) => m.origin === 'watch:turn-end')).toHaveLength(1);
  });
```
(`engine!['index']` reaches a private field for one test; acceptable in a test. `AgentClient` type import from `../src/runner/agent-client`.) Note that the second send to `s-basic` passes the busy check: `idleSince` grace covers Relay's own transcript writes, and the fake doesn't touch the file. Run → FAIL.

- [ ] **Step 2:** Implementation in `relay-engine.ts`:
  - `RelayEngineOptions.orchestratorDir: string`. In `start`, `await mkdir(opts.orchestratorDir, { recursive: true })`, then construct everything. The constructor creates `this.orchestrator = new Orchestrator({ cwd: resolve(orchestratorDir), client: agent, approvals, store, tools: createRelayTools({ listSessions: () => this.listSessions(), runState: () => this.runState(), getTranscript: (id) => this.getTranscript(id), send: (req) => this.send(req), interrupt: (id) => this.interrupt(id) }) })`. Wire `orchestrator.on('state', (state, error) => this.publish({ type: 'state', sessionId: ORCHESTRATOR_KEY, state, error }))` and `on('entry', …)` the same way.
  - `listSessions()`: `this.index.list().filter((s) => resolve(s.cwd) !== this.orchestratorCwd)`. `createRunner` and `assertNotBusy` look sessions up through `this.listSessions()`, so the orchestrator's own sessions come back as `Unknown session`.
  - In `createRunner` add `runner.on('turn-end', (end) => this.relayTurnEnd(session, end))`, with
    ```ts
    private relayTurnEnd(session: SessionSummary, end: TurnEnd): void {
      if (!end.origins.includes('orchestrator')) return;
      const where = `session "${session.title}" (${session.id}${session.branch ? `, ${session.branch}` : ''})`;
      const outcome = end.error
        ? ` finished with an error: ${end.error}`
        : ` finished. Last reply: ${end.lastText ? clip(end.lastText, 600) : '(no text)'}`;
      void this.orchestrator.send(`[turn-end] ${where}${outcome}`, { origin: 'watch:turn-end', mode: 'queue' });
    }
    ```
  - `orchestratorSend(prompt) => this.orchestrator.send(prompt)`, `orchestratorInterrupt() => this.orchestrator.interrupt()`.
  - `orchestratorHistory()`: `const id = this.orchestrator.sessionId; if (!id) return []; try { return await this.index.getTranscript(id); } catch { return []; }`.
  - `close()`: `await this.orchestrator.close()` before the runners.
  - Export `Orchestrator`, `createRelayTools`, `TurnEnd` from `index.ts`.
- [ ] **Step 3:** `pnpm --filter @relay/engine test && pnpm typecheck` → green. The live test file needs `orchestratorDir` too: `join(root, 'orch')`. Commit `feat(engine): orchestrator in the engine, completion relay`.

---

### Task 8: Desktop main process

**Files:** Modify `apps/desktop/src/ipc.ts`, `apps/desktop/src/main.ts`.

- [ ] **Step 1:** In `registerEngineIpc` add
```ts
  handle(IPC.orchestratorSend, (prompt: string) => engine.orchestratorSend(prompt));
  handle(IPC.orchestratorInterrupt, () => engine.orchestratorInterrupt());
  handle(IPC.orchestratorHistory, () => engine.orchestratorHistory());
```
and add the three channels to `channels`.
- [ ] **Step 2:** In `main.ts` pass `orchestratorDir: join(app.getPath('userData'), 'orchestrator')` to `RelayEngine.start`. The approval notification must skip orchestrator events (`event.approval.sessionId !== ORCHESTRATOR_KEY`); error notifications stay.
- [ ] **Step 3:** `pnpm typecheck && pnpm --filter @relay/desktop test:e2e` → green (existing e2e must still boot). Commit `feat(desktop): orchestrator over IPC`.

---

### Task 9: Orchestrator chat UI

**Files:** Create `apps/desktop/src/ui/OrchestratorChat.tsx`, `apps/desktop/src/ui/OrchestratorChat.test.tsx`; modify `apps/desktop/src/ui/App.tsx`, `apps/desktop/src/ui/styles.css`, `apps/desktop/src/ui/App.test.tsx`.

**Interfaces:**
- Consumes: `useRunState()` (its `liveEntries[ORCHESTRATOR_KEY]` and `states[ORCHESTRATOR_KEY]`), `window.relay.orchestratorSend/Interrupt/History`, `TranscriptView`.
- Produces: `<OrchestratorChat history liveEntries state onSend onInterrupt />`. It shows the history followed by the live entries, merged by uuid the same way as `SessionPanel`. Extract that `merge` into `apps/desktop/src/ui/mergeEntries.ts` and use it from both components, since there are now two callers. User messages that came from the relay (`origin: 'watch:turn-end'`) render as a compact grey "update" line instead of a user bubble.
  - The input is a textarea: Enter sends, Shift+Enter adds a newline. It clears on send.
  - A state badge shows `idle` / `running`, and an Interrupt button appears while running.
  - The input stays usable while running. Sends are steers, which is the M2 default.

- [ ] **Step 1 (red):** `OrchestratorChat.test.tsx`:
```tsx
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { LiveEntry, TranscriptEntry } from '@relay/shared';
import { OrchestratorChat } from './OrchestratorChat';

const text = (uuid: string, role: 'user' | 'assistant', t: string): TranscriptEntry => ({
  uuid, role, timestamp: '2026-09-23T10:00:00.000Z', isSidechain: false, isMeta: false, blocks: [{ kind: 'text', text: t }],
});

describe('OrchestratorChat', () => {
  it('shows history then live entries, deduped, with relay updates as compact lines', () => {
    const live: LiveEntry[] = [
      { ...text('h2', 'assistant', 'dup'), origin: 'user' },
      { ...text('l1', 'user', '[turn-end] session "A" finished. Last reply: ok'), origin: 'watch:turn-end' },
      { ...text('l2', 'assistant', 'Session A is done.'), origin: 'watch:turn-end' },
    ];
    render(
      <OrchestratorChat history={[text('h1', 'user', 'hi'), text('h2', 'assistant', 'hello')]} liveEntries={live}
        state={undefined} onSend={vi.fn()} onInterrupt={vi.fn()} />,
    );
    expect(screen.getByText('hi')).toBeInTheDocument();
    expect(screen.getByText('hello')).toBeInTheDocument();
    expect(screen.queryByText('dup')).not.toBeInTheDocument();
    expect(screen.getByRole('status', { name: 'Relay update' })).toHaveTextContent('session "A" finished');
    expect(screen.getByText('Session A is done.')).toBeInTheDocument();
  });

  it('Enter sends and clears, Shift+Enter makes a newline, Interrupt shows while running', async () => {
    const onSend = vi.fn();
    const onInterrupt = vi.fn();
    const { rerender } = render(
      <OrchestratorChat history={[]} liveEntries={[]} state={{ state: 'idle', error: null }} onSend={onSend} onInterrupt={onInterrupt} />,
    );
    const box = screen.getByPlaceholderText('Ask Relay…');
    await userEvent.type(box, 'line one{Shift>}{Enter}{/Shift}line two{Enter}');
    expect(onSend).toHaveBeenCalledWith('line one\nline two');
    expect(box).toHaveValue('');
    expect(screen.queryByRole('button', { name: 'Interrupt' })).not.toBeInTheDocument();
    rerender(
      <OrchestratorChat history={[]} liveEntries={[]} state={{ state: 'running', error: null }} onSend={onSend} onInterrupt={onInterrupt} />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Interrupt' }));
    expect(onInterrupt).toHaveBeenCalled();
  });
});
```
In `App.test.tsx` add a test: rendering `App` calls `orchestratorHistory` once; typing in "Ask Relay…" and pressing Enter calls `orchestratorSend('hello')`; an `entry` runner event with `sessionId: 'orchestrator'` shows up in the chat and not in the session panel. Run → FAIL.

- [ ] **Step 2:** `mergeEntries.ts`:
```ts
import type { LiveEntry, TranscriptEntry } from '@relay/shared';
import type { ViewEntry } from './TranscriptView';

/** File entries first, then live ones the file has not caught up with yet. */
export function mergeEntries(entries: TranscriptEntry[], live: LiveEntry[]): ViewEntry[] {
  const seen = new Set(entries.map((e) => e.uuid));
  return [...entries, ...live.filter((e) => !seen.has(e.uuid))];
}
```
Replace `merge` in `SessionPanel.tsx` with it.

`OrchestratorChat.tsx`: render a header (`Relay` + state badge + Interrupt when running), then the list. For each merged entry: if `role === 'user'` and the origin starts with `watch:`, or the first text starts with `[turn-end]`, render `<div role="status" aria-label="Relay update" className="relay-update">{text without the "[turn-end] " prefix}</div>`. Otherwise use a `TranscriptView` over the non-update entries. To keep order, render entries one by one with a small `ChatEntry` that delegates to `TranscriptView` for a single entry: `<TranscriptView entries={[e]} hideSidechain />`. Below the list, a textarea `placeholder="Ask Relay…"` with the onKeyDown `Enter && !shiftKey → preventDefault, send`.

`App.tsx`:
  - `const [orchHistory, setOrchHistory] = useState<TranscriptEntry[]>([])`, with `useEffect(() => { void window.relay.orchestratorHistory().then(setOrchHistory); }, [])`.
  - Replace the placeholder with `<OrchestratorChat history={orchHistory} liveEntries={run.liveEntries[ORCHESTRATOR_KEY] ?? []} state={run.states[ORCHESTRATOR_KEY]} onSend={(p) => void window.relay.orchestratorSend(p)} onInterrupt={() => void window.relay.orchestratorInterrupt()} />`, keeping the `ApprovalsDrawer` below it.
  - Filter `run.approvals` for the session panel as before. The orchestrator is never `selected` because it isn't in `sessions`.
  - The chat auto-scrolls with the same follow-the-bottom logic as the session panel. Extract that logic into `useFollowBottom(ref, deps)` in `apps/desktop/src/ui/useFollowBottom.ts` and use it in both components, since there are two callers now.

Styles:
```css
.orchestrator { display: flex; flex-direction: column; padding-bottom: 0; }
.chat { flex: 1; overflow: auto; }
.chat__header { display: flex; gap: 8px; align-items: center; margin-bottom: 8px; }
.relay-update { font-size: 12px; opacity: .65; margin: 4px 0 10px; padding-left: 8px; border-left: 2px solid currentColor; }
.chat-input { position: sticky; bottom: 0; background: Canvas; padding: 8px 0; }
.chat-input textarea { width: 100%; box-sizing: border-box; font: inherit; }
```
- [ ] **Step 3:** `pnpm --filter @relay/desktop test && pnpm typecheck` → green. Commit `feat(desktop): orchestrator chat`.

---

### Task 10: Live check and README

**Files:** Modify `packages/engine/test/live/sdk-live.test.ts`, `README.md`.

- [ ] **Step 1:** Add a live case, gated like the others, using the scratch session:
```ts
  it('the orchestrator finds the scratch session, sends to it and reports the turn end', async () => {
    events.length = 0;
    await engine.orchestratorSend(
      'Send the session in repo relay-scratch this instruction: "Reply with exactly the word: relayed". Do not ask me to confirm.',
    );
    await waitFor(
      () => events.some((e) => e.type === 'entry' && e.sessionId === sessionId && e.entry.blocks.some((b) => b.kind === 'text' && b.text.toLowerCase().includes('relayed'))),
      180_000,
    );
    await waitFor(
      () => events.some((e) => e.type === 'entry' && e.sessionId === ORCHESTRATOR_KEY && e.entry.origin === 'watch:turn-end'),
      180_000,
    );
  }, 400_000);
```
`beforeAll` passes `orchestratorDir: join(root, 'orch')`. Run with `RELAY_LIVE=-private-tmp-relay-scratch pnpm --filter @relay/engine test live` → 5 passed.
- [ ] **Step 2:** README: replace "Orchestrator chat arrives in milestone 3" mentions with a short "Orchestrator (M3)" section: ask in the middle column; it can list, inspect, send to and interrupt one session at a time; when a session it drove finishes, it tells you.
- [ ] **Step 3:** Commit `docs: orchestrator; live check`.

---

## Follow-ups

- M4 bulk actions add `propose_bulk_action` and plan cards; the system-prompt line about one session per request changes then.
- The orchestrator's own turn-end is not relayed anywhere; M5 notifications may want it.
