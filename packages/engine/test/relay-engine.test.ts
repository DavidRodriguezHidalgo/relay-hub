import { afterEach, describe, expect, it } from 'vitest';
import { copyFile, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RunnerEvent } from '@relay/shared';
import { RelayEngine } from '../src/relay-engine';
import type { AgentClient } from '../src/runner/agent-client';
import type { GhClient, PrData, PrRef } from '../src/pr/gh-client';

class FakeGh implements GhClient {
  data: PrData = {
    number: 42, url: 'https://github.com/org/repo/pull/42', title: 'M', state: 'OPEN', headRefName: 'feat/a',
    headRefOid: 'h1', baseRefName: 'main', mergeable: 'MERGEABLE', mergeStateStatus: 'BLOCKED', checks: [], feedback: [],
  };
  found: PrRef | null = null;
  /** Per-number overrides; anything else reads `data`. */
  prs: Record<number, PrData> = {};
  async viewer() {
    return 'me';
  }
  async viewPr(_repo: string, n: number) {
    return this.prs[n] ?? this.data;
  }
  async findPrForBranch() {
    return this.found;
  }
  mine: { repo: string; number: number; url: string; title: string; headRefName: string; state: string }[] = [];
  async listMyPrs() {
    return this.mine;
  }
}
import { SessionBusyError } from '../src/runner/session-busy-error';
import { FakeAgentClient, tick } from './runner/fake-agent-client';

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

describe('RelayEngine', () => {
  let root: string;
  let engine: RelayEngine | null = null;
  afterEach(async () => {
    await engine?.close();
    engine = null;
    await rm(root, { recursive: true, force: true });
  });

  async function startWithBasic(
    client: AgentClient,
    now = () => new Date('2026-09-23T00:00:00.000Z'),
    extra: {
      idleTimeoutMs?: number;
      registry?: { foreignHolders(id: string): Promise<number[]>; openSessions?(): Promise<Record<string, 'busy' | 'idle'>>; release?(id: string): Promise<number[]> };
      externalPollMs?: number;
      more?: boolean;
      noPr?: boolean;
      bulkConcurrency?: number;
      gh?: GhClient;
      worktrees?: { repoRoot(cwd: string): Promise<string | null>; createWorktree(root: string, branch: string): Promise<string> };
      createTimeoutMs?: number;
      workState?: () => Promise<import('../src/git/work-state').WorkState>;
      branchWork?: () => Promise<import('../src/git/branch-work').BranchWork>;
      updates?: { repo: string; currentVersion: string; fetch?: (url: string) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }> };
    } = {},
  ) {
    root = await mkdtemp(join(tmpdir(), 'relay-engine-'));
    const cwd = join(root, 'wt-a');
    await mkdir(cwd);
    await mkdir(join(root, 'projects', 'p'), { recursive: true });
    const src = await readFile(fixture('basic.jsonl'), 'utf8');
    const file = join(root, 'projects', 'p', 's-basic.jsonl');
    await writeFile(file, src.replaceAll('/repo/wt-a', cwd));
    const old = new Date('2026-09-20T10:01:00.000Z');
    await utimes(file, old, old); // last written days ago: nobody else is driving it
    const { more, noPr, ...engineExtra } = extra;
    if (noPr) {
      const cwdC = join(root, 'wt-c');
      await mkdir(cwdC);
      const nopr = join(root, 'projects', 'p', 's-nopr.jsonl');
      const withoutPr = src.split('\n').filter((l) => !l.includes('"pr-link"')).join('\n');
      await writeFile(nopr, withoutPr.replaceAll('/repo/wt-a', cwdC).replaceAll('s-basic', 's-nopr'));
      await utimes(nopr, old, old);
    }
    if (more) {
      const cwdB = join(root, 'wt-b');
      await mkdir(cwdB);
      const two = join(root, 'projects', 'p', 's-two.jsonl');
      await writeFile(two, src.replaceAll('/repo/wt-a', cwdB).replaceAll('s-basic', 's-two'));
      await utimes(two, old, old);
    }
    engine = await RelayEngine.start({
      projectsDir: join(root, 'projects'),
      dbPath: join(root, 'relay.db'),
      git: { inspect: async () => ({ branch: 'feat/a', repo: 'r' }) },
      agent: client,
      now,
      orchestratorDir: join(root, 'orch'),
      // never the real ~/.claude/sessions: tests must not see what else runs on this machine
      registry: { foreignHolders: async () => [] },
      ...engineExtra,
    });
    return { cwd, file };
  }

  it('starts with an initial scan and serves transcripts', async () => {
    root = await mkdtemp(join(tmpdir(), 'relay-engine-'));
    await mkdir(join(root, 'projects', 'p'), { recursive: true });
    await copyFile(fixture('no-prompt.jsonl'), join(root, 'projects', 'p', 's-noprompt.jsonl'));
    engine = await RelayEngine.start({
      projectsDir: join(root, 'projects'),
      dbPath: join(root, 'relay.db'),
      git: { inspect: async () => ({ branch: null, repo: null }) },
      orchestratorDir: join(root, 'orch'),
    });
    expect(engine.listSessions().map((s) => s.id)).toEqual(['s-noprompt']);
    expect(await engine.getTranscript('s-noprompt')).toHaveLength(2);
  });

  it("lists what a session can be asked to run, from that session's own directory", async () => {
    const client = new FakeAgentClient();
    client.invocables = [{ name: 'review', description: 'Review the diff', argumentHint: '[pr]' }];
    const { cwd } = await startWithBasic(client);
    // Relay's own commands come first, then what this directory offers
    expect((await engine!.listCommands('s-basic')).map((c) => c.name)).toEqual(['btw', 'review']);
    expect(client.described).toEqual([cwd]);
    await expect(engine!.listCommands('nope')).rejects.toThrow('Unknown session nope');
  });

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
    // the prompt itself, then the reply; the queue is covered on its own below
    expect(events.map((e) => e.type).filter((t) => t !== 'queue')).toEqual(['entry', 'state', 'entry', 'state']);
    expect(engine!.runState().states['s-basic']).toEqual({ state: 'idle', error: null });
  });

  it('send refuses a session whose transcript someone else wrote in the last 15 s', async () => {
    const client = new FakeAgentClient();
    const { file } = await startWithBasic(client, () => new Date());
    const now = new Date();
    await utimes(file, now, now);
    await expect(
      engine!.send({ sessionId: 's-basic', prompt: 'hi', mode: 'steer', origin: 'user' }),
    ).rejects.toBeInstanceOf(SessionBusyError);
    expect(client.starts).toHaveLength(0);
  });

  it('send refuses a session another live Claude process holds, even when its transcript is quiet', async () => {
    const client = new FakeAgentClient();
    await startWithBasic(client, undefined, {
      registry: { foreignHolders: async (id: string) => (id === 's-basic' ? [4242] : []) },
    });
    await expect(
      engine!.send({ sessionId: 's-basic', prompt: 'hi', mode: 'steer', origin: 'user' }),
    ).rejects.toThrow(/open in another Claude process \(pid 4242\)/);
    expect(client.starts).toHaveLength(0);
  });

  it('send rejects an unknown session id', async () => {
    await startWithBasic(new FakeAgentClient());
    await expect(
      engine!.send({ sessionId: 'nope', prompt: 'x', mode: 'steer', origin: 'user' }),
    ).rejects.toThrow(/unknown session/i);
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
    expect(events.find((e) => e.type === 'approval')).toMatchObject({
      approval: { id: approval.id, reason: 'destructive-git' },
    });
    engine!.decide(approval.id, { kind: 'deny', message: 'no' });
    expect(await outcome).toEqual({ behavior: 'deny', message: 'no' });
    expect(events).toContainEqual({ type: 'approval-resolved', approvalId: approval.id, decision: 'deny' });
    // the runner leaves waiting-approval once the decision lands
    expect(events.at(-1)).toMatchObject({ type: 'state', sessionId: 's-basic', state: 'running' });
  });

  it('two concurrent first sends start one run, not two', async () => {
    const client = new FakeAgentClient();
    await startWithBasic(client);
    await Promise.all([
      engine!.send({ sessionId: 's-basic', prompt: 'a', mode: 'steer', origin: 'user' }),
      engine!.send({ sessionId: 's-basic', prompt: 'b', mode: 'steer', origin: 'user' }),
    ]);
    await tick();
    expect(client.starts).toHaveLength(1);
    expect(client.received.map((m) => m.text)).toEqual(['a', 'b']);
  });

  it('re-checks for another writer on every send to an idle runner', async () => {
    const client = new FakeAgentClient();
    const { file } = await startWithBasic(client, () => new Date());
    await engine!.send({ sessionId: 's-basic', prompt: 'a', mode: 'steer', origin: 'user' });
    await tick();
    client.result();
    await tick();
    expect(engine!.runState().states['s-basic']?.state).toBe('idle');
    // a terminal writes the transcript after Relay went idle
    await new Promise((r) => setTimeout(r, 1_100));
    const now = new Date();
    await utimes(file, now, now);
    await expect(
      engine!.send({ sessionId: 's-basic', prompt: 'b', mode: 'steer', origin: 'user' }),
    ).rejects.toBeInstanceOf(SessionBusyError);
  });

  it('closes an idle runner after the idle timeout and drops its state', async () => {
    const client = new FakeAgentClient();
    await startWithBasic(client, undefined, { idleTimeoutMs: 30 });
    await engine!.send({ sessionId: 's-basic', prompt: 'a', mode: 'steer', origin: 'user' });
    await tick();
    client.result();
    await tick();
    expect(engine!.runState().states['s-basic']?.state).toBe('idle');
    await new Promise((r) => setTimeout(r, 80));
    expect(engine!.runState().states['s-basic']).toBeUndefined();
    // the next send starts a fresh run
    await engine!.send({ sessionId: 's-basic', prompt: 'b', mode: 'steer', origin: 'user' });
    await tick();
    expect(client.starts).toHaveLength(2);
  });

  it('close interrupts running sessions', async () => {
    const client = new FakeAgentClient();
    await startWithBasic(client);
    await engine!.send({ sessionId: 's-basic', prompt: 'a', mode: 'steer', origin: 'user' });
    await tick();
    await engine!.close();
    expect(client.interrupts).toBe(1);
    engine = null;
  });

  it("hides the orchestrator's own sessions from the list and from send", async () => {
    const client = new FakeAgentClient();
    await startWithBasic(client);
    const orchDir = join(root, 'orch');
    const own = join(root, 'projects', 'orch-proj');
    await mkdir(own, { recursive: true });
    const src = await readFile(fixture('basic.jsonl'), 'utf8');
    await writeFile(join(own, 'o-1.jsonl'), src.replaceAll('/repo/wt-a', orchDir).replaceAll('s-basic', 'o-1'));
    const pushed: string[][] = [];
    engine!.onSessionsChanged((list) => pushed.push(list.map((x) => x.id)));
    const index = (engine as unknown as { index: { scan(): Promise<unknown>; list(): unknown[]; emit(e: string, v: unknown): void } }).index;
    await index.scan();
    expect(engine!.listSessions().map((x) => x.id)).toEqual(['s-basic']);
    // the watcher's change events go to the sidebar and must be filtered too; emit one directly
    // rather than waiting on FSEvents, which a loaded machine may coalesce or delay
    index.emit('changed', index.list());
    expect(pushed).toEqual([['s-basic']]);
    await expect(
      engine!.send({ sessionId: 'o-1', prompt: 'x', mode: 'steer', origin: 'user' }),
    ).rejects.toThrow(/unknown session/i);
  });

  it('routes orchestrator messages and publishes its events under the orchestrator key', async () => {
    const client = new FakeAgentClient();
    await startWithBasic(client);
    const events: RunnerEvent[] = [];
    engine!.onEvent((e) => events.push(e));
    await engine!.orchestratorSend('what is running?');
    await tick();
    const { realpath } = await import('node:fs/promises');
    expect(client.starts[0]).toMatchObject({ sessionId: null, cwd: await realpath(join(root, 'orch')), profile: { kind: 'orchestrator' } });
    expect(events[0]).toMatchObject({ type: 'entry', sessionId: 'orchestrator', entry: { role: 'user' } });
    expect(await engine!.orchestratorHistory()).toEqual([]);
  });

  it('relays the end of a turn the orchestrator started, and only those', async () => {
    const orchClient = new FakeAgentClient();
    const sessionClient = new FakeAgentClient();
    const router: AgentClient = {
      start: (opts) => (opts.profile?.kind === 'orchestrator' ? orchClient : sessionClient).start(opts),
    };
    await startWithBasic(router);
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
    expect(relayed[0]!.text).toBe(
      '[turn-end] session "Add tests for the zero-rate case" (s-basic, feat/a) finished. Last reply: Added 3 tests.',
    );
    // a user dev-box send to the same session does not wake the orchestrator
    await engine!.send({ sessionId: 's-basic', prompt: 'more', mode: 'steer', origin: 'user' });
    await tick();
    sessionClient.result();
    await tick();
    expect(orchClient.received.filter((m) => m.origin === 'watch:turn-end')).toHaveLength(1);
  });

  function routed() {
    const orchClient = new FakeAgentClient();
    const sessionClient = new FakeAgentClient();
    const router: AgentClient = {
      start: (opts) => (opts.profile?.kind === 'orchestrator' ? orchClient : sessionClient).start(opts),
    };
    return { orchClient, sessionClient, router };
  }

  it('quitting while a driven session runs does not start a new orchestrator turn', async () => {
    const { orchClient, router } = routed();
    await startWithBasic(router);
    await engine!.orchestratorSend('tell s-basic to add tests');
    await tick();
    await orchClient.callTool('send_to_session', { id: 's-basic', prompt: 'add tests' });
    await tick();
    orchClient.result(); // orchestrator idle, session still running
    await tick();
    await engine!.close();
    engine = null;
    expect(orchClient.starts).toHaveLength(1);
    expect(orchClient.received.filter((m) => m.origin === 'watch:turn-end')).toHaveLength(0);
  });

  it('a turn started only by a relay cannot send to sessions on its own', async () => {
    const { orchClient, sessionClient, router } = routed();
    await startWithBasic(router);
    await engine!.orchestratorSend('tell s-basic to add tests');
    await tick();
    await orchClient.callTool('send_to_session', { id: 's-basic', prompt: 'add tests' });
    orchClient.result();
    await tick();
    sessionClient.assistant('a1', 'Done. Shall I also update the docs?');
    sessionClient.result();
    await tick();
    // the orchestrator is now running a turn caused only by the [turn-end] relay
    const r = await orchClient.callTool('send_to_session', { id: 's-basic', prompt: 'yes, update the docs' });
    expect(r).toMatchObject({ isError: true });
    expect(r.text).toMatch(/ask the user/i);
    expect(sessionClient.received.map((m) => m.text)).toEqual(['add tests']);
  });

  it('a proposed bulk run sends nothing until confirmed, then sends every row with its bulk origin', async () => {
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

  function perSessionRouter() {
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
    return { orchClient, perSession, router };
  }

  it('an interrupted bulk row is reported as an error, not done', async () => {
    const { orchClient, perSession, router } = perSessionRouter();
    await startWithBasic(router, undefined, { more: true });
    await engine!.orchestratorSend('x');
    await tick();
    const { bulkRunId } = JSON.parse(
      (await orchClient.callTool('propose_bulk_action', { targets: [{ id: 's-basic' }, { id: 's-two' }], prompt: 'p' })).text,
    );
    engine!.bulkConfirm(bulkRunId, ['s-basic', 's-two']);
    await tick();
    await tick();
    perSession.get('s-basic')!.assistant('a1', 'Starting the rebase, first I will');
    await tick();
    await engine!.interrupt('s-basic');
    await tick();
    perSession.get('s-two')!.result();
    await tick();
    const run = engine!.runState().bulkRuns[0]!;
    expect(run.rows.map((r) => [r.sessionId, r.status, r.detail])).toEqual([
      ['s-basic', 'error', 'Interrupted: Starting the rebase, first I will'],
      ['s-two', 'done', null],
    ]);
    expect(orchClient.received.find((m) => m.origin === 'watch:bulk-end')!.text).toContain('1 done, 1 error');
  });

  it('a run still going when Relay closed is finished with errors on the next start', async () => {
    const { orchClient, perSession, router } = perSessionRouter();
    await startWithBasic(router, undefined, { more: true, bulkConcurrency: 1 });
    await engine!.orchestratorSend('x');
    await tick();
    const { bulkRunId } = JSON.parse(
      (await orchClient.callTool('propose_bulk_action', { targets: [{ id: 's-basic' }, { id: 's-two' }], prompt: 'p' })).text,
    );
    engine!.bulkConfirm(bulkRunId, ['s-basic', 's-two']);
    await tick();
    await tick();
    await engine!.close();
    // the queued row must not be started while Relay shuts down
    expect(perSession.has('s-two')).toBe(false);
    engine = await RelayEngine.start({
      projectsDir: join(root, 'projects'), dbPath: join(root, 'relay.db'), orchestratorDir: join(root, 'orch'),
      agent: new FakeAgentClient(), git: { inspect: async () => ({ branch: 'feat/a', repo: 'r' }) },
    });
    const run = engine.runState().bulkRuns[0]!;
    expect(run.id).toBe(bulkRunId);
    expect(run.status).toBe('finished');
    expect(run.rows.map((r) => [r.sessionId, r.status, r.detail])).toEqual([
      ['s-basic', 'error', 'Relay was closed during the run'],
      ['s-two', 'error', 'Relay was closed during the run'],
    ]);
  });

  it('a relay-only orchestrator turn cannot propose a bulk action', async () => {
    const { orchClient, sessionClient, router } = routed();
    await startWithBasic(router, undefined, { more: true });
    await engine!.orchestratorSend('tell s-basic to add tests');
    await tick();
    await orchClient.callTool('send_to_session', { id: 's-basic', prompt: 'add tests' });
    orchClient.result();
    await tick();
    sessionClient.result();
    await tick();
    const r = await orchClient.callTool('propose_bulk_action', { targets: [{ id: 's-basic' }, { id: 's-two' }], prompt: 'more' });
    expect(r).toMatchObject({ isError: true });
    expect(engine!.runState().bulkRuns).toEqual([]);
  });

  const pollNow = () => (engine as unknown as { watcher: { pollAll(): Promise<void> } }).watcher.pollAll();

  it("watching a session's PR wakes it with a queued watch message when CI fails, and never the orchestrator", async () => {
    const { orchClient, perSession, router } = perSessionRouter();
    const gh = new FakeGh();
    await startWithBasic(router, undefined, { gh });
    const watch = await engine!.watchCreate('s-basic');
    expect(watch).toMatchObject({ repo: 'org/repo', prNumber: 42, active: true });
    const events: RunnerEvent[] = [];
    engine!.onEvent((e) => events.push(e));
    gh.data = { ...gh.data, checks: [{ name: 'test', conclusion: 'FAILURE', status: 'COMPLETED' }] };
    await pollNow();
    // the wake creates a runner first (busy checks read the process registry), so wait for it to land
    for (let i = 0; !perSession.get('s-basic')?.received.length && i < 100; i += 1) await tick();
    expect(engine!.runState().watches[0]!.lastError).toBeNull();
    expect(events.find((e) => e.type === 'pr-event')).toMatchObject({ sessionId: 's-basic', event: { kind: 'ci_failed' } });
    expect(events.find((e) => e.type === 'watch')).toMatchObject({ gh: { state: 'ok' } });
    const woke = perSession.get('s-basic')!.received;
    expect(woke).toHaveLength(1);
    expect(woke[0]).toMatchObject({ priority: 'next', origin: 'watch:ci_failed' });
    expect(woke[0]!.text).toContain('Newly failing checks: test');
    perSession.get('s-basic')!.result();
    await tick();
    expect(orchClient.received.filter((m) => m.origin.startsWith('watch:'))).toHaveLength(0);
    expect(engine!.runState().watches).toHaveLength(1);
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
    let holders: number[] = [];
    await startWithBasic(new FakeAgentClient(), undefined, { gh, registry: { foreignHolders: async () => holders } });
    await engine!.watchCreate('s-basic');
    holders = [99];
    gh.data = { ...gh.data, checks: [{ name: 'test', conclusion: 'FAILURE', status: 'COMPLETED' }] };
    await pollNow();
    for (let i = 0; !engine!.runState().watches[0]!.wakeError && i < 100; i += 1) await tick();
    expect(engine!.runState().watches[0]!.wakeError).toMatch(/open in another Claude process/);
  });

  it('a merged PR notifies but does not wake the session', async () => {
    const { perSession, router } = perSessionRouter();
    const gh = new FakeGh();
    await startWithBasic(router, undefined, { gh });
    await engine!.watchCreate('s-basic');
    const events: RunnerEvent[] = [];
    engine!.onEvent((e) => events.push(e));
    gh.data = { ...gh.data, state: 'MERGED' };
    await pollNow();
    await tick();
    expect(events.find((e) => e.type === 'pr-event')).toMatchObject({ event: { kind: 'merged' } });
    expect(perSession.has('s-basic')).toBe(false);
    expect(engine!.runState().watches[0]!.active).toBe(false);
  });

  it('activeSessions lists running sessions for the quit dialog', async () => {
    const client = new FakeAgentClient();
    await startWithBasic(client);
    expect(engine!.activeSessions()).toEqual([]);
    await engine!.send({ sessionId: 's-basic', prompt: 'x', mode: 'steer', origin: 'user' });
    await tick();
    expect(engine!.activeSessions()).toEqual([{ id: 's-basic', title: 'Add tests for the zero-rate case', state: 'running' }]);
  });

  it('a recorded PR that is merged is not watched: falls back to the open PR for the branch, else says so', async () => {
    const gh = new FakeGh();
    await startWithBasic(new FakeAgentClient(), undefined, { gh });
    gh.data = { ...gh.data, state: 'MERGED' };
    gh.found = null;
    await expect(engine!.watchCreate('s-basic')).rejects.toThrow(/PR #42 is merged/);
    expect(engine!.runState().watches).toEqual([]);
    gh.found = { repo: 'org/repo', number: 43, url: 'https://github.com/org/repo/pull/43' };
    gh.prs[42] = { ...gh.data, number: 42, state: 'MERGED' };
    gh.data = { ...gh.data, state: 'OPEN', number: 43 };
    expect(await engine!.watchCreate('s-basic')).toMatchObject({ prNumber: 43, active: true });
  });

  it('deleting a watch publishes its removal', async () => {
    const gh = new FakeGh();
    await startWithBasic(new FakeAgentClient(), undefined, { gh });
    const events: RunnerEvent[] = [];
    engine!.onEvent((e) => events.push(e));
    const w = await engine!.watchCreate('s-basic');
    engine!.watchDelete(w.id);
    expect(events.at(-1)).toEqual({ type: 'watch-removed', watchId: w.id, gh: { state: 'ok' } });
  });

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

  it('approvals a created session asks for carry its real session id', async () => {
    const client = new FakeAgentClient();
    const wt = fakeWorktrees({});
    await startWithBasic(client, undefined, { worktrees: wt });
    const dir = join(root, 'plain2');
    await mkdir(dir);
    const creating = engine!.createSession({ project: dir, prompt: 'x', origin: 'user' });
    for (let i = 0; !client.lastOpts && i < 100; i += 1) await tick();
    client.init('born-1');
    await creating;
    void client.askTool('Bash', { command: 'git push --force' });
    await tick();
    expect(engine!.runState().approvals.map((a) => a.sessionId)).toEqual(['born-1']);
  });

  it('an absolute worktree path without a branch starts the session in that exact directory, never the main clone', async () => {
    const client = new FakeAgentClient();
    const wt = fakeWorktrees({});
    await startWithBasic(client, undefined, { worktrees: wt });
    const main = join(root, 'repo');
    const worktree = join(root, 'repo-worktrees', 'feat-a');
    await mkdir(worktree, { recursive: true });
    wt.repoRoot = async (cwd: string) => (cwd === worktree ? main : null);
    const creating = engine!.createSession({ project: worktree, prompt: 'x', origin: 'user' });
    for (let i = 0; !client.lastOpts && i < 100; i += 1) await tick();
    expect(client.lastOpts?.cwd).toBe(worktree);
    client.init('w-1');
    expect(await creating).toEqual({ sessionId: 'w-1', cwd: worktree });
  });

  it('refuses to start a session in a main clone: a project name, or its path, without a branch', async () => {
    const client = new FakeAgentClient();
    const wt = fakeWorktrees({});
    await startWithBasic(client, undefined, { worktrees: wt });
    const repo = join(root, 'myrepo');
    await mkdir(repo);
    wt.repoRoot = async (cwd: string) => (cwd.endsWith('wt-a') || cwd === repo ? repo : null);
    await expect(engine!.createSession({ project: 'myrepo', prompt: 'x', origin: 'orchestrator' })).rejects.toThrow(
      /main checkout.*give a new branch/i,
    );
    await expect(engine!.createSession({ project: repo, prompt: 'x', origin: 'orchestrator' })).rejects.toThrow(/main checkout/i);
    expect(client.starts).toHaveLength(0);
  });

  it("interrupting a session that is not running says so instead of claiming success", async () => {
    await startWithBasic(new FakeAgentClient());
    expect(await engine!.interrupt("s-basic")).toBe(false);
    await expect(engine!.interrupt("nope")).rejects.toThrow(/unknown session/i);
  });

  it("runState includes the orchestrator, so a reloaded window knows it is running", async () => {
    const client = new FakeAgentClient();
    await startWithBasic(client);
    await engine!.orchestratorSend("x");
    await tick();
    expect(engine!.runState().states["orchestrator"]).toEqual({ state: "running", error: null });
  });

  it("many driven sessions do not trip the EventEmitter listener warning", async () => {
    const warnings: string[] = [];
    const onWarning = (w: Error) => warnings.push(w.name);
    process.on("warning", onWarning);
    const client = new FakeAgentClient();
    await startWithBasic(client);
    const approvals = (engine as unknown as { approvals: import("node:events").EventEmitter }).approvals;
    expect(approvals.getMaxListeners()).toBe(0);
    process.off("warning", onWarning);
    expect(warnings).not.toContain("MaxListenersExceededWarning");
  });

  it("hides the orchestrator's sessions even when the transcript records the real path of a symlinked dir", async () => {
    await startWithBasic(new FakeAgentClient());
    const { realpath } = await import("node:fs/promises");
    const real = await realpath(join(root, "orch"));
    const own = join(root, "projects", "orch-real");
    await mkdir(own, { recursive: true });
    const src = await readFile(fixture("basic.jsonl"), "utf8");
    await writeFile(join(own, "o-2.jsonl"), src.replaceAll("/repo/wt-a", real).replaceAll("s-basic", "o-2"));
    await (engine as unknown as { index: { scan(): Promise<unknown> } }).index.scan();
    expect(engine!.listSessions().map((x) => x.id)).toEqual(["s-basic"]);
  });

  it("a cancelled bulk plan tells the orchestrator, so it does not think the run is pending", async () => {
    const { orchClient, router } = routed();
    await startWithBasic(router, undefined, { more: true });
    await engine!.orchestratorSend("x");
    await tick();
    const { bulkRunId } = JSON.parse(
      (await orchClient.callTool("propose_bulk_action", { targets: [{ id: "s-basic" }, { id: "s-two" }], prompt: "p" })).text,
    );
    engine!.bulkCancel(bulkRunId);
    await tick();
    expect(orchClient.received.filter((m) => m.origin === "watch:bulk-end").map((m) => m.text)).toEqual([
      `[bulk-end] run ${bulkRunId} was cancelled by the user; nothing ran.`,
    ]);
  });

  it("watches of sessions that no longer exist are dropped", async () => {
    const gh = new FakeGh();
    await startWithBasic(new FakeAgentClient(), undefined, { gh });
    const w = await engine!.watchCreate("s-basic");
    await rm(join(root, "wt-a"), { recursive: true });
    await (engine as unknown as { index: { scan(): Promise<unknown>; emit(e: string, v: unknown): void; list(): unknown[] } }).index.scan();
    (engine as unknown as { index: { emit(e: string, v: unknown): void; list(): unknown[] } }).index.emit("changed", []);
    await tick();
    expect(engine!.runState().watches.map((x) => x.id)).not.toContain(w.id);
  });

  it("list_prs matches a PR to the session in the same repo when a branch name repeats across repos", async () => {
    const gh = new FakeGh();
    await startWithBasic(new FakeAgentClient(), undefined, { gh, more: true });
    gh.mine = [{ repo: "org/r", number: 1, url: "u1", title: "A", headRefName: "feat/a", state: "OPEN" }];
    const listPrs = (engine as unknown as { listPrs(): Promise<{ sessionId: string | null }[]> }).listPrs.bind(engine);
    // both fixture sessions record branch feat/a; the git fake reports repo "r" for both, so the repo narrows nothing
    // and the first-by-activity rule is not used: ambiguous means no session
    expect((await listPrs())[0]!.sessionId).toBeNull();
  });

  it("publishes which sessions are open in other Claude processes, and only when that changes", async () => {
    let open: Record<string, "busy" | "idle"> = {};
    await startWithBasic(new FakeAgentClient(), undefined, {
      registry: { foreignHolders: async () => [], openSessions: async () => open },
      externalPollMs: 20,
    });
    const events: RunnerEvent[] = [];
    engine!.onEvent((e) => events.push(e));
    open = { "s-basic": "busy" };
    await new Promise((r) => setTimeout(r, 80));
    expect(engine!.runState().external).toEqual({ "s-basic": "busy" });
    expect(events.filter((e) => e.type === "external")).toEqual([{ type: "external", external: { "s-basic": "busy" } }]);
  });
  it('takes a session over by stopping what holds it, and stops showing it as held', async () => {
    const released: string[] = [];
    const client = new FakeAgentClient();
    await startWithBasic(client, undefined, {
      externalPollMs: 60_000,
      registry: {
        foreignHolders: async () => (released.length > 0 ? [] : [4242]),
        openSessions: async (): Promise<Record<string, 'busy' | 'idle'>> =>
          released.length > 0 ? {} : { 's-basic': 'busy' },
        release: async (id: string) => {
          released.push(id);
          return [4242];
        },
      },
    });
    const seen: RunnerEvent[] = [];
    engine!.onEvent((e) => seen.push(e));
    expect(await engine!.takeOver('s-basic')).toEqual([4242]);
    expect(released).toEqual(['s-basic']);
    expect(seen).toContainEqual({ type: 'external', external: {} });
    await expect(engine!.takeOver('nope')).rejects.toThrow('Unknown session nope');
  });
  it('sends straight after a take over, though the stopped process had only just written', async () => {
    const client = new FakeAgentClient();
    await startWithBasic(client, undefined, {
      externalPollMs: 60_000,
      registry: {
        foreignHolders: async () => [],
        openSessions: async (): Promise<Record<string, 'busy' | 'idle'>> => ({}),
        release: async () => [4242],
      },
    });
    const file = join(root, 'projects', 'p', 's-basic.jsonl');
    const asItDied = new Date('2026-09-22T23:59:55.000Z');
    await utimes(file, asItDied, asItDied);
    const send = () => engine!.send({ sessionId: 's-basic', prompt: 'hi', mode: 'steer', origin: 'user' });
    await expect(send()).rejects.toThrow(/being written by another process/);
    await engine!.takeOver('s-basic');
    await expect(send()).resolves.toBeTruthy();
  });
  it('remembers that everything was allowed, and stops asking about it', async () => {
    const client = new FakeAgentClient();
    await startWithBasic(client);
    expect(engine!.settings()).toEqual({ allowAllActions: false });
    engine!.setAllowAllActions(true);
    expect(engine!.settings()).toEqual({ allowAllActions: true });
    await engine!.close();

    // a later run of the app, reading the same stored state
    engine = await RelayEngine.start({
      projectsDir: join(root, 'projects'),
      dbPath: join(root, 'relay.db'),
      git: { inspect: async () => ({ branch: 'feat/a', repo: 'r' }) },
      agent: client,
      orchestratorDir: join(root, 'orch'),
      registry: { foreignHolders: async () => [] },
    });
    expect(engine!.settings()).toEqual({ allowAllActions: true });
  });
  it('answers a side question from a fork of the session, leaving the session and its turn alone', async () => {
    const client = new FakeAgentClient();
    await startWithBasic(client);
    // the main session is mid-turn
    await engine!.send({ sessionId: 's-basic', prompt: 'keep working', mode: 'steer', origin: 'user' });
    await tick();
    expect(client.starts).toHaveLength(1);
    const seen: RunnerEvent[] = [];
    engine!.onEvent((e) => seen.push(e));

    const answer = engine!.aside('s-basic', 'why did you pick sqlite?');
    await tick();
    // a second run, forked from the same id, kept off disk, and never registered as the session's runner
    expect(client.starts).toHaveLength(2);
    expect(client.starts[1]).toMatchObject({ sessionId: 's-basic', fork: true, persist: false });
    expect(client.received.at(-1)).toMatchObject({ text: 'why did you pick sqlite?', origin: 'aside', priority: 'now' });
    client.assistant('a1', 'Because it needs no server.');
    client.result();
    await expect(answer).resolves.toBe('Because it needs no server.');

    const entries = seen.filter((e) => e.type === 'entry' && e.sessionId === 's-basic');
    expect(entries.map((e) => (e.type === 'entry' ? e.entry.origin : null))).toEqual(['aside', 'aside']);
    expect(entries.map((e) => (e.type === 'entry' ? e.entry.role : null))).toEqual(['user', 'assistant']);
    // the main turn was never interrupted or touched
    expect(client.interrupts).toBe(0);
    expect(engine!.runState().states['s-basic']?.state).toBe('running');
    await expect(engine!.aside('nope', 'x')).rejects.toThrow('Unknown session nope');
  });

  it('puts Relay’s own commands ahead of the session’s in the / menu', async () => {
    const client = new FakeAgentClient();
    client.invocables = [{ name: 'review', description: 'Review the diff', argumentHint: '[pr]' }];
    await startWithBasic(client);
    const names = (await engine!.listCommands('s-basic')).map((c) => c.name);
    expect(names).toEqual(['btw', 'review']);
  });
  it('asks GitHub whether a newer release exists, using the version it was started with', async () => {
    const client = new FakeAgentClient();
    const asked: string[] = [];
    await startWithBasic(client, undefined, {
      updates: {
        repo: 'o/r',
        currentVersion: '0.1.0',
        fetch: async (url) => {
          asked.push(url);
          return { ok: true, status: 200, json: async () => ({ tag_name: 'v0.3.0', html_url: 'https://github.com/o/r/releases/tag/v0.3.0', body: 'notes' }) };
        },
      },
    });
    expect(await engine!.checkForUpdate()).toMatchObject({ current: '0.1.0', latest: '0.3.0', newer: true, notes: 'notes' });
    expect(asked).toEqual(['https://api.github.com/repos/o/r/releases/latest']);
  });

  it('says so when a build was not told where its releases live', async () => {
    await startWithBasic(new FakeAgentClient());
    expect(await engine!.checkForUpdate()).toMatchObject({ newer: false, error: expect.stringContaining('releases') });
  });
  it('lists the models a session can run on, marking the one it is on', async () => {
    const client = new FakeAgentClient();
    client.models = [
      { id: 'opus[1m]', name: 'Opus', description: 'Best for complex work', current: false },
      { id: 'sonnet', name: 'Sonnet', description: 'Efficient', current: false },
    ];
    await startWithBasic(client);
    // nothing has run yet: the session's own default is in force, so nothing is marked
    expect((await engine!.listModels('s-basic')).map((m) => [m.id, m.current])).toEqual([['opus[1m]', false], ['sonnet', false]]);

    await engine!.send({ sessionId: 's-basic', prompt: 'go', mode: 'steer', origin: 'user' });
    await tick();
    client.init('s-basic', 'sonnet');
    await tick();
    expect((await engine!.listModels('s-basic')).find((m) => m.current)?.id).toBe('sonnet');
    await expect(engine!.listModels('nope')).rejects.toThrow('Unknown session nope');
  });

  it('switches a running session to another model, and starts the next run on it', async () => {
    const client = new FakeAgentClient();
    client.models = [{ id: 'opus[1m]', name: 'Opus', description: '', current: false }];
    await startWithBasic(client);
    await engine!.send({ sessionId: 's-basic', prompt: 'go', mode: 'steer', origin: 'user' });
    await tick();

    await engine!.setModel('s-basic', 'opus[1m]');
    expect(client.modelChanges).toEqual(['opus[1m]']);

    // the choice outlives the app: a later run starts on it without being told again
    await engine!.close();
    engine = await RelayEngine.start({
      projectsDir: join(root, 'projects'),
      dbPath: join(root, 'relay.db'),
      git: { inspect: async () => ({ branch: 'feat/a', repo: 'r' }) },
      agent: client,
      orchestratorDir: join(root, 'orch'),
      registry: { foreignHolders: async () => [] },
    });
    await engine!.send({ sessionId: 's-basic', prompt: 'again', mode: 'steer', origin: 'user' });
    await tick();
    expect(client.starts.at(-1)?.model).toBe('opus[1m]');
    await expect(engine!.setModel('nope', 'x')).rejects.toThrow('Unknown session nope');
  });

  it('reports what was sent to a session and what became of it', async () => {
    const client = new FakeAgentClient();
    await startWithBasic(client);
    const seen: RunnerEvent[] = [];
    engine!.onEvent((e) => seen.push(e));

    await engine!.send({ sessionId: 's-basic', prompt: 'do the thing', mode: 'steer', origin: 'user' });
    await tick();
    expect(engine!.runState().queue['s-basic']).toMatchObject([{ text: 'do the thing', origin: 'user', state: 'pending' }]);
    expect(seen.some((e) => e.type === 'queue' && e.sessionId === 's-basic')).toBe(true);

    client.result();
    await tick();
    expect(engine!.runState().queue['s-basic']?.[0]?.state).toBe('done');
  });

  it('reports where the work stands, from git and the pull request', async () => {
    const client = new FakeAgentClient();
    await startWithBasic(client, undefined, {
      workState: async () => ({
        branch: 'feat/a',
        lastCommit: { sha: 'abc1234def', subject: 'the last thing', at: '2026-09-25T09:00:00.000Z' },
        uncommitted: 2,
        unpushed: 1,
        upstream: 'origin/feat/a',
      }),
      gh: {
        viewer: async () => 'me',
        viewPr: async () => ({
          number: 12, url: 'https://github.com/o/r/pull/12', title: 'T', state: 'OPEN' as const,
          headRefName: 'feat/a', headRefOid: 'x', baseRefName: 'main', mergeable: 'MERGEABLE' as const,
          mergeStateStatus: 'CLEAN',
          checks: [{ name: 'typecheck', conclusion: 'SUCCESS', status: null }, { name: 'e2e', conclusion: 'FAILURE', status: null }],
          feedback: [],
        }),
        findPrForBranch: async () => null,
        listMyPrs: async () => [],
      },
    });
    const status = await engine!.sessionStatus('s-basic');
    expect(status).toMatchObject({
      branch: 'feat/a', uncommitted: 2, unpushed: 1,
      lastCommit: { subject: 'the last thing' },
      pr: { number: 12, state: 'OPEN' },
      note: null,
    });
    expect(status.checks).toEqual([{ name: 'typecheck', conclusion: 'SUCCESS' }, { name: 'e2e', conclusion: 'FAILURE' }]);
  });

  it('says there is nothing to report rather than leaving a blank that looks like a pass', async () => {
    const client = new FakeAgentClient();
    await startWithBasic(client, undefined, {
      noPr: true,
      workState: async () => ({ branch: 'feat/a', lastCommit: null, uncommitted: 0, unpushed: 0, upstream: null }),
    });
    const status = await engine!.sessionStatus('s-nopr');
    expect(status.checks).toBeNull();
    expect(status.note).toMatch(/no pull request/i);
  });

  it('reports a forge that could not be asked, instead of pretending there are no checks', async () => {
    const client = new FakeAgentClient();
    await startWithBasic(client, undefined, {
      workState: async () => ({ branch: 'feat/a', lastCommit: null, uncommitted: 0, unpushed: 0, upstream: null }),
      gh: {
        viewer: async () => 'me',
        viewPr: async () => { throw new Error('gh: not logged in'); },
        findPrForBranch: async () => null,
        listMyPrs: async () => [],
      },
    });
    const status = await engine!.sessionStatus('s-basic');
    expect(status.checks).toBeNull();
    expect(status.note).toMatch(/not logged in/);
    await expect(engine!.sessionStatus('nope')).rejects.toThrow('Unknown session nope');
  });

  it('reports what a session produced and what it still has open', async () => {
    const client = new FakeAgentClient();
    await startWithBasic(client, undefined, {
      branchWork: async () => ({
        commits: [{ sha: 'a'.repeat(40), subject: 'did the thing', at: '2026-09-25T09:00:00.000Z' }],
        files: ['src/a.ts', 'src/b.ts'],
        moreFiles: 3,
        base: 'main',
        note: null,
      }),
    });
    await engine!.send({ sessionId: 's-basic', prompt: 'unanswered', mode: 'steer', origin: 'user' });
    await tick();
    const done = await engine!.accomplished('s-basic');
    expect(done.commits.map((c) => c.subject)).toEqual(['did the thing']);
    expect(done.files).toEqual(['src/a.ts', 'src/b.ts']);
    expect(done.moreFiles).toBe(3);
    expect(done.open).toEqual(['1 instruction not answered yet']);
    await expect(engine!.accomplished('nope')).rejects.toThrow('Unknown session nope');
  });

  it('counts an approval waiting on the user as an open thread', async () => {
    const client = new FakeAgentClient();
    await startWithBasic(client, undefined, {
      branchWork: async () => ({ commits: [], files: [], moreFiles: 0, base: 'main', note: null }),
    });
    await engine!.send({ sessionId: 's-basic', prompt: 'go', mode: 'steer', origin: 'user' });
    await tick();
    void client.askTool('Bash', { command: 'git push --force' });
    await tick();
    const done = await engine!.accomplished('s-basic');
    expect(done.open).toContain('1 approval waiting on you');
  });

  it('marks a stopped turn in the transcript, so it reads differently from a normal ending', async () => {
    const client = new FakeAgentClient();
    await startWithBasic(client);
    const seen: RunnerEvent[] = [];
    engine!.onEvent((e) => seen.push(e));
    await engine!.send({ sessionId: 's-basic', prompt: 'go', mode: 'steer', origin: 'user' });
    await tick();
    expect(await engine!.interrupt('s-basic')).toBe(true);
    await tick();
    const notices = seen.filter((e) => e.type === 'entry' && e.entry.notice);
    expect(notices).toHaveLength(1);
    expect(notices[0]!.type === 'entry' && notices[0]!.entry.notice).toBe('You stopped this turn.');
    expect(engine!.runState().states['s-basic']).toEqual({ state: 'idle', error: null });
  });

  it('says nothing about stopping when a turn simply finishes', async () => {
    const client = new FakeAgentClient();
    await startWithBasic(client);
    const seen: RunnerEvent[] = [];
    engine!.onEvent((e) => seen.push(e));
    await engine!.send({ sessionId: 's-basic', prompt: 'go', mode: 'steer', origin: 'user' });
    await tick();
    client.result();
    await tick();
    expect(seen.filter((e) => e.type === 'entry' && e.entry.notice)).toEqual([]);
  });
});
