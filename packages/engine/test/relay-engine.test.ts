import { afterEach, describe, expect, it } from 'vitest';
import { copyFile, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RunnerEvent } from '@relay/shared';
import { RelayEngine } from '../src/relay-engine';
import type { AgentClient } from '../src/runner/agent-client';
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
    extra: { idleTimeoutMs?: number; registry?: { foreignHolders(id: string): Promise<number[]> }; more?: boolean } = {},
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
    const { more, ...engineExtra } = extra;
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
    expect(events.map((e) => e.type)).toEqual(['entry', 'state', 'entry', 'state']); // the prompt itself, then the reply
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
    await (engine as unknown as { index: { scan(): Promise<unknown> } }).index.scan();
    expect(engine!.listSessions().map((x) => x.id)).toEqual(['s-basic']);
    // the watcher's change events go to the sidebar: they must be filtered too
    for (let waited = 0; pushed.length === 0 && waited < 5_000; waited += 50) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(pushed.length).toBeGreaterThan(0);
    expect(pushed.at(-1)).toEqual(['s-basic']);
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
    expect(client.starts[0]).toMatchObject({ sessionId: null, cwd: join(root, 'orch'), profile: { kind: 'orchestrator' } });
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
    expect(run.id).toBe(bulkRunId);
    expect(run.status).toBe('finished');
    expect(run.rows.every((r) => r.status === 'error' || r.status === 'done')).toBe(true);
  });
});
