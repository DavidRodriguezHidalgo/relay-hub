import { describe, expect, it, vi } from 'vitest';
import type { DeliveryMode, SessionSummary, TranscriptEntry } from '@relay/shared';
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
    runState: () => ({ states: { a: { state: 'running', error: null } }, approvals: [], bulkRuns: [], watches: [], gh: { state: 'ok' }, external: {} }),
    getTranscript: async () => [],
    send: vi.fn(async () => 'm-1'),
    interrupt: vi.fn(async () => true),
    proposeBulk: vi.fn(async (targets: { sessionId: string; prompt: string }[], mode: DeliveryMode) => ({
      id: 'r1', createdAt: 'x', mode, status: 'proposed' as const,
      rows: targets.map((t) => ({
        sessionId: t.sessionId, title: 't', branch: null, prompt: t.prompt, status: 'proposed' as const, detail: null,
      })),
    })),
    listPrs: vi.fn(async () => [
      { repo: 'o/r', number: 7, url: 'u', title: 'M', branch: 'feat/mileage', sessionId: 'a', watched: false },
    ]),
    createWatch: vi.fn(async (id: string) => ({
      id: 'w1', sessionId: id, repo: 'o/r', prNumber: 7, prUrl: 'u', active: true, createdAt: 'x', lastPolledAt: 'x', lastError: null,
    })),
    deleteWatch: vi.fn(async () => undefined),
    listProjects: vi.fn(async () => [{ name: 'factorial', root: '/code/factorial', sessions: 3 }]),
    createSession: vi.fn(async () => ({ sessionId: 'n1', cwd: '/code/factorial-worktrees/feat-x' })),
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
      'list_sessions', 'get_session', 'send_to_session', 'interrupt_session', 'propose_bulk_action',
      'list_prs', 'create_watch', 'delete_watch', 'list_projects', 'create_session',
    ]);
  });

  it('list_sessions filters, hides stale, sorts newest first and includes run state', async () => {
    const all = JSON.parse((await call(deps(), 'list_sessions', {})).text).sessions;
    expect(all.map((r: { id: string }) => r.id)).toEqual(['a', 'b']);
    expect(all[0]).toEqual({
      id: 'a', repo: 'repo', branch: 'feat/mileage', title: 'Mileage claims', state: 'running',
      lastActivity: '2026-09-22T00:00:00.000Z', prNumber: 12, pendingApprovals: 0,
    });
    const found = JSON.parse((await call(deps(), 'list_sessions', { query: 'MILEAGE' })).text).sessions;
    expect(found.map((r: { id: string }) => r.id)).toEqual(['a']);
    const withStale = JSON.parse((await call(deps(), 'list_sessions', { includeStale: true })).text).sessions;
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
    expect(r.recent).toHaveLength(8);
    expect(r.recent[0].content[0]).toHaveLength(241); // 240 + ellipsis
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
    const d = deps({
      send: async () => {
        throw new Error('Session a is open in another Claude process (pid 7)');
      },
    });
    expect(await call(d, 'send_to_session', { id: 'a', prompt: 'x' })).toEqual({
      text: 'Session a is open in another Claude process (pid 7)', isError: true,
    });
  });

  it('interrupt_session interrupts and reports errors as tool errors', async () => {
    const d = deps();
    expect(JSON.parse((await call(d, 'interrupt_session', { id: 'a' })).text)).toEqual({ interrupted: true });
    expect(d.interrupt).toHaveBeenCalledWith('a');
    const bad = deps({
      interrupt: async () => {
        throw new Error('nope');
      },
    });
    expect(await call(bad, 'interrupt_session', { id: 'a' })).toEqual({ text: 'nope', isError: true });
  });

  it('propose_bulk_action proposes with per-target prompts falling back to the shared one', async () => {
    const d = deps();
    const r = await call(d, 'propose_bulk_action', {
      targets: [{ id: 'a' }, { id: 'b', prompt: 'special' }], prompt: 'rebase onto main',
    });
    expect(d.proposeBulk).toHaveBeenCalledWith(
      [{ sessionId: 'a', prompt: 'rebase onto main' }, { sessionId: 'b', prompt: 'special' }], 'steer',
    );
    expect(JSON.parse(r.text)).toMatchObject({ bulkRunId: 'r1', status: 'proposed', rows: 2 });
  });

  it('propose_bulk_action reports a refusal as a tool error', async () => {
    const d = deps({
      proposeBulk: async () => {
        throw new Error('Unknown session zz');
      },
    });
    expect(await call(d, 'propose_bulk_action', { targets: [{ id: 'a' }, { id: 'zz' }], prompt: 'x' })).toEqual({
      text: 'Unknown session zz', isError: true,
    });
  });

  it('list_prs, create_watch and delete_watch call through and report errors as tool errors', async () => {
    const d = deps();
    expect(JSON.parse((await call(d, 'list_prs', {})).text)).toEqual([
      { repo: 'o/r', number: 7, url: 'u', title: 'M', branch: 'feat/mileage', sessionId: 'a', watched: false },
    ]);
    expect(JSON.parse((await call(d, 'create_watch', { id: 'a' })).text)).toMatchObject({ watching: true, prNumber: 7 });
    expect(d.createWatch).toHaveBeenCalledWith('a');
    expect(JSON.parse((await call(d, 'delete_watch', { id: 'a' })).text)).toEqual({ watching: false });
    expect(d.deleteWatch).toHaveBeenCalledWith('a');
    const bad = deps({
      createWatch: async () => {
        throw new Error('No pull request found for session "A" (branch none)');
      },
    });
    expect(await call(bad, 'create_watch', { id: 'a' })).toEqual({
      text: 'No pull request found for session "A" (branch none)', isError: true,
    });
  });

  it('list_projects and create_session call through; failures are tool errors', async () => {
    const d = deps();
    expect(JSON.parse((await call(d, 'list_projects', {})).text)).toEqual([{ name: 'factorial', root: '/code/factorial', sessions: 3 }]);
    const r = await call(d, 'create_session', { project: 'factorial', branch: 'feat/x', prompt: 'Add tests' });
    expect(d.createSession).toHaveBeenCalledWith({ project: 'factorial', branch: 'feat/x', prompt: 'Add tests' });
    expect(JSON.parse(r.text)).toEqual({ created: true, sessionId: 'n1', cwd: '/code/factorial-worktrees/feat-x' });
    const bad = deps({
      createSession: async () => {
        throw new Error('The branch feat/x already exists; pick another name or use its worktree');
      },
    });
    expect(await call(bad, 'create_session', { project: 'factorial', branch: 'feat/x', prompt: 'x' })).toMatchObject({ isError: true });
  });

  it("get_session caps blocks per entry and clips approval summaries", async () => {
    const entries = [{
      uuid: "e", role: "user" as const, timestamp: "t", isSidechain: false, isMeta: false,
      blocks: Array.from({ length: 40 }, (_, i) => ({ kind: "tool_result" as const, toolUseId: String(i), text: "x".repeat(300), isError: false })),
    }];
    const d = deps({
      getTranscript: async () => entries,
      runState: () => ({
        states: {}, bulkRuns: [], watches: [], gh: { state: "ok" as const }, external: {},
        approvals: [{ id: "p", sessionId: "a", toolName: "Bash", input: {}, summary: "y".repeat(2000), reason: "destructive-git" as const, cwd: "/c", createdAt: "t" }],
      }),
    });
    const r = JSON.parse((await call(d, "get_session", { id: "a" })).text);
    expect(r.recent[0].content.length).toBeLessThanOrEqual(13); // 12 blocks + a "more" marker
    expect(r.approvals[0].summary.length).toBeLessThanOrEqual(301);
  });
});

describe('relay tools and the orchestrator’s context', () => {
  /** Every token a tool returns is re-read on every later turn, so the lists are kept short. */
  const many = Array.from({ length: 40 }, (_, i) =>
    s({ id: `s${i}`, title: `Session ${i}`, lastActivity: `2026-09-${String(10 + (i % 20)).padStart(2, '0')}T00:00:00.000Z` }),
  );

  it('returns a page of sessions and says how many more matched, rather than all of them', async () => {
    const out = JSON.parse((await call(deps({ listSessions: () => many }), 'list_sessions', {})).text);
    expect(out.sessions).toHaveLength(20);
    expect(out.more).toBe(20);
    expect(out.hint).toMatch(/query/i);
  });

  it('says nothing about more when everything matched', async () => {
    const out = JSON.parse((await call(deps({ listSessions: () => many.slice(0, 5) }), 'list_sessions', {})).text);
    expect(out.sessions).toHaveLength(5);
    expect(out.more).toBe(0);
    expect(out.hint).toBeUndefined();
  });

  it('keeps one session’s detail to the last few turns', async () => {
    const entries: TranscriptEntry[] = Array.from({ length: 30 }, (_, i) => ({
      uuid: `e${i}`, role: 'assistant', timestamp: '2026-09-22T00:00:00.000Z', isSidechain: false, isMeta: false,
      blocks: [{ kind: 'text', text: `line ${i}` }],
    }));
    const out = JSON.parse((await call(deps({ getTranscript: async () => entries }), 'get_session', { id: 'a' })).text);
    expect(out.recent).toHaveLength(8);
    expect(out.recent.at(-1).content[0]).toContain('line 29');
  });
});
