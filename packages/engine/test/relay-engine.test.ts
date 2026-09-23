import { afterEach, describe, expect, it } from 'vitest';
import { copyFile, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RunnerEvent } from '@relay/shared';
import { RelayEngine } from '../src/relay-engine';
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
    client: FakeAgentClient,
    now = () => new Date('2026-09-23T00:00:00.000Z'),
    extra: { idleTimeoutMs?: number; registry?: { foreignHolders(id: string): Promise<number[]> } } = {},
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
    engine = await RelayEngine.start({
      projectsDir: join(root, 'projects'),
      dbPath: join(root, 'relay.db'),
      git: { inspect: async () => ({ branch: 'feat/a', repo: 'r' }) },
      agent: client,
      now,
      ...extra,
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
    expect(events.map((e) => e.type)).toEqual(['state', 'entry', 'state']);
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
});
