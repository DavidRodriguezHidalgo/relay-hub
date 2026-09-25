import { describe, expect, it } from 'vitest';
import type { LiveEntry, SessionState } from '@relay/shared';
import { ApprovalQueue } from '../../src/approvals/approval-queue';
import { SessionRunner } from '../../src/runner/session-runner';
import { FakeAgentClient, tick } from './fake-agent-client';

function setup(closeTimeoutMs = 5_000) {
  const client = new FakeAgentClient();
  const approvals = new ApprovalQueue();
  const runner = new SessionRunner({ sessionId: 's1', cwd: '/repo', client, approvals, closeTimeoutMs });
  const states: SessionState[] = [];
  const entries: LiveEntry[] = [];
  runner.on('state', (s) => states.push(s));
  runner.on('entry', (e) => entries.push(e));
  return { client, approvals, runner, states, entries };
}

const sent = (client: FakeAgentClient) => client.received.map((m) => [m.text, m.priority]);

describe('SessionRunner', () => {
  it('starts lazily on the first send and reports entries with the origin, then idles on result', async () => {
    const { client, runner, states, entries } = setup();
    expect(runner.state).toBe('idle');
    expect(client.starts).toHaveLength(0);
    const id = await runner.send('do x', { mode: 'steer', origin: 'orchestrator' });
    expect(id).toMatch(/.+/);
    await tick();
    expect(client.starts[0]).toMatchObject({ sessionId: 's1', cwd: '/repo' });
    expect(client.received).toEqual([{ id, text: 'do x', priority: 'now', origin: 'orchestrator' }]);
    expect(runner.state).toBe('running');
    client.assistant('a1', 'working');
    client.result();
    await tick();
    expect(entries.map((e) => e.role)).toEqual(['user', 'assistant']);
    expect(entries[1]).toMatchObject({ uuid: 'a1', role: 'assistant', origin: 'orchestrator' });
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
    expect(sent(client)).toEqual([['a', 'now'], ['b', 'next'], ['c', 'now']]);
  });

  it('a second send while running reuses the same run', async () => {
    const { client, runner } = setup();
    await runner.send('a', { mode: 'steer', origin: 'user' });
    await runner.send('b', { mode: 'steer', origin: 'user' });
    expect(client.starts).toHaveLength(1);
  });

  it('a steer folded into the running turn is settled by that turn: one result → idle', async () => {
    const { client, runner } = setup();
    await runner.send('a', { mode: 'steer', origin: 'user' });
    await runner.send('b', { mode: 'steer', origin: 'user' });
    await tick();
    client.result(); // the SDK emits one result per turn, not per send
    await tick();
    expect(runner.state).toBe('idle');
  });

  it('stays running while the SDK still has queued turns, idles when the last one ends', async () => {
    const { client, runner } = setup();
    const a = await runner.send('a', { mode: 'steer', origin: 'user' });
    await runner.send('b', { mode: 'queue', origin: 'user' });
    await tick();
    client.result(null, 1, [a]);
    await tick();
    expect(runner.state).toBe('running');
    client.result(null, 0);
    await tick();
    expect(runner.state).toBe('idle');
  });

  it('an entry arriving while idle flips the session back to running', async () => {
    const { client, runner } = setup();
    await runner.send('a', { mode: 'steer', origin: 'user' });
    await tick();
    client.result();
    await tick();
    expect(runner.state).toBe('idle');
    client.assistant('late', 'still going'); // e.g. a turn the last result did not account for
    await tick();
    expect(runner.state).toBe('running');
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

  it("tells the agent which calls need the user, per this session's allowed patterns", async () => {
    const { client, approvals, runner } = setup();
    await runner.send('x', { mode: 'steer', origin: 'user' });
    await tick();
    const needs = client.lastOpts!.needsApproval!;
    expect(needs('Bash', { command: 'ls' })).toBe(false);
    expect(needs('Bash', { command: 'git push --force' })).toBe(true);
    const outcome = client.askTool('Bash', { command: 'git push --force' });
    approvals.decide(approvals.pending()[0]!.id, { kind: 'allow-pattern' });
    await outcome;
    expect(needs('Bash', { command: 'git push --force' })).toBe(false);
  });

  it('interrupt denies pending approvals and the aborted turn ends normally, not in error', async () => {
    const { client, approvals, runner, states } = setup();
    await runner.send('x', { mode: 'steer', origin: 'user' });
    await tick();
    const outcome = client.askTool('Bash', { command: 'git reset --hard' });
    await tick();
    await runner.interrupt();
    expect(await outcome).toEqual({ behavior: 'deny', message: 'interrupted' });
    expect(approvals.pending()).toEqual([]);
    await tick();
    expect(runner.state).toBe('idle');
    expect(states).not.toContain('error');
  });

  it('an interrupt-mode send is not lost to the aborted turn result', async () => {
    const { client, runner } = setup();
    await runner.send('long task', { mode: 'steer', origin: 'user' });
    await tick();
    await runner.send('stop and say done', { mode: 'interrupt', origin: 'user' });
    await tick();
    expect(sent(client)).toEqual([['long task', 'now'], ['stop and say done', 'now']]);
    expect(runner.state).toBe('running');
    expect(runner.error).toBeNull();
    client.result();
    await tick();
    expect(runner.state).toBe('idle');
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

  it('an error names the queued messages it dropped', async () => {
    const { client, runner } = setup();
    await runner.send('x', { mode: 'steer', origin: 'user' });
    await runner.send('later 1', { mode: 'queue', origin: 'watch:ci_failed' });
    await runner.send('later 2', { mode: 'queue', origin: 'user' });
    await tick();
    client.result('api error', 2, []);
    await tick();
    expect(runner.state).toBe('error');
    expect(runner.error).toBe('api error (2 queued messages dropped)');
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

  it('close interrupts the run and cancels approvals, but a kind already allowed stays allowed', async () => {
    const { client, approvals, runner } = setup();
    await runner.send('x', { mode: 'steer', origin: 'user' });
    await tick();
    const first = client.askTool('Bash', { command: 'git push -f' });
    await tick();
    approvals.decide(approvals.pending()[0]!.id, { kind: 'allow-pattern' });
    await first;
    await runner.close();
    expect(client.interrupts).toBe(1);
    // the session is driven again later: what the user allowed is not asked a second time
    const again = new SessionRunner({ sessionId: 's1', cwd: '/repo', client, approvals });
    await again.send('y', { mode: 'steer', origin: 'user' });
    await tick();
    const second = client.askTool('Bash', { command: 'git push -f' });
    await tick();
    expect(approvals.pending()).toEqual([]);
    expect(await second).toEqual({ behavior: 'allow' });
    await again.close();
  });

  it('close gives up on a run that never ends after the timeout', async () => {
    const { client, runner } = setup(30);
    await runner.send('x', { mode: 'steer', origin: 'user' });
    await tick();
    client.failWith = null;
    // make the fake ignore end-of-input: keep the output open by never ending it
    const stuck = new Promise<void>(() => undefined);
    (runner as unknown as { consuming: Promise<void> }).consuming = stuck;
    const started = Date.now();
    await runner.close();
    expect(Date.now() - started).toBeLessThan(1_000);
  });

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

  it('resetSession makes the next run start fresh', async () => {
    const client = new FakeAgentClient();
    const runner = new SessionRunner({ sessionId: 'orchestrator', resume: 'old', cwd: '/o', client, approvals: new ApprovalQueue() });
    await runner.send('hi', { mode: 'steer', origin: 'user' });
    await tick();
    client.result('gone');
    await tick();
    runner.resetSession();
    await runner.send('again', { mode: 'steer', origin: 'user' });
    await tick();
    expect(client.starts.map((s) => s.sessionId)).toEqual(['old', null]);
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
    expect(ends).toEqual([{ origins: ['orchestrator'], lastText: 'final answer', error: null, aborted: false }]);
  });

  it('turn-end on error carries the reason', async () => {
    const { client, runner } = setup();
    const ends: unknown[] = [];
    runner.on('turn-end', (e) => ends.push(e));
    await runner.send('a', { mode: 'steer', origin: 'orchestrator' });
    await tick();
    client.result('api error');
    await tick();
    expect(ends).toEqual([{ origins: ['orchestrator'], lastText: null, error: 'api error', aborted: false }]);
  });

  it('an interrupted turn ends with aborted set', async () => {
    const { client, runner } = setup();
    const ends: unknown[] = [];
    runner.on('turn-end', (e) => ends.push(e));
    await runner.send('long', { mode: 'steer', origin: 'orchestrator' });
    await tick();
    client.assistant('a1', 'Starting the rebase, first I will');
    await tick();
    await runner.interrupt();
    await tick();
    expect(ends).toEqual([{ origins: ['orchestrator'], lastText: 'Starting the rebase, first I will', error: null, aborted: true }]);
  });

  it("tags a queued send's turn with its own origin, and a running turn keeps the origin that started it", async () => {
    const { client, runner, entries } = setup();
    const first = await runner.send("user work", { mode: "steer", origin: "user" });
    await runner.send("ci failed", { mode: "queue", origin: "watch:ci_failed" });
    await tick();
    client.out.push({ type: "assistant", uuid: "a1", timestamp: "t", blocks: [{ kind: "text", text: "on it" }], sendId: first, sidechain: false });
    await tick();
    expect(entries.find((e) => e.uuid === "a1")?.origin).toBe("user");
    const second = client.received[1]!.id;
    client.result(null, 1, [first]);
    client.out.push({ type: "assistant", uuid: "a2", timestamp: "t", blocks: [{ kind: "text", text: "fixing ci" }], sendId: second, sidechain: false });
    await tick();
    expect(entries.find((e) => e.uuid === "a2")?.origin).toBe("watch:ci_failed");
  });

  it("marks subagent frames as sidechain", async () => {
    const { client, runner, entries } = setup();
    await runner.send("x", { mode: "steer", origin: "user" });
    await tick();
    client.out.push({ type: "assistant", uuid: "s1", timestamp: "t", blocks: [{ kind: "text", text: "sub" }], sendId: null, sidechain: true });
    await tick();
    expect(entries.find((e) => e.uuid === "s1")?.isSidechain).toBe(true);
  });

  it("dying while waiting for approval goes straight to error, without a running blip", async () => {
    const { client, runner, states } = setup();
    await runner.send("x", { mode: "steer", origin: "user" });
    await tick();
    void client.askTool("Bash", { command: "git clean -fd" });
    await tick();
    client.die(new Error("process exited"));
    await tick();
    await tick();
    expect(states).toEqual(["running", "waiting-approval", "error"]);
  });

  it("close gives up on an interrupt that never answers", async () => {
    const { client, runner } = setup(30);
    await runner.send("x", { mode: "steer", origin: "user" });
    await tick();
    client.hangInterrupt = true;
    const started = Date.now();
    await runner.close();
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("when the runtime names the sends a turn consumed, the others stay outstanding", async () => {
    const { client, runner } = setup();
    const a = await runner.send("user work", { mode: "steer", origin: "user" });
    const b = await runner.send("bulk row", { mode: "steer", origin: "bulk:r1" });
    await tick();
    client.result(null, 0, [a]);
    await tick();
    expect(runner.state).toBe("running");
    client.result(null, 0, [b]);
    await tick();
    expect(runner.state).toBe("idle");
  });
});

describe('SessionRunner instruction queue', () => {
  it('shows an instruction as pending until the turn that answers it settles', async () => {
    const { client, runner } = setup();
    const queues: string[][] = [];
    runner.on('queue', (q) => queues.push(q.map((m) => `${m.text}:${m.state}`)));

    await runner.send('first', { mode: 'steer', origin: 'user' });
    await runner.send('second', { mode: 'queue', origin: 'orchestrator' });
    await tick();
    expect(runner.queue.map((m) => [m.text, m.origin, m.state])).toEqual([
      ['first', 'user', 'pending'],
      ['second', 'orchestrator', 'pending'],
    ]);

    client.result(null, 0, [client.received[0]!.id]);
    await tick();
    expect(runner.queue.map((m) => [m.text, m.state])).toEqual([['first', 'done'], ['second', 'pending']]);

    client.result();
    await tick();
    expect(runner.queue.every((m) => m.state === 'done')).toBe(true);
    expect(queues.length).toBeGreaterThan(2);
  });

  it('marks what was never answered as dropped when the run dies', async () => {
    const { client, runner } = setup();
    await runner.send('will be lost', { mode: 'steer', origin: 'user' });
    await tick();
    client.die(new Error('the agent went away'));
    await tick();
    expect(runner.queue.map((m) => [m.text, m.state])).toEqual([['will be lost', 'dropped']]);
  });

  it('marks what was never answered as dropped when the session is closed', async () => {
    const { client, runner } = setup();
    await runner.send('unanswered', { mode: 'steer', origin: 'user' });
    await tick();
    void client;
    await runner.close();
    expect(runner.queue.map((m) => m.state)).toEqual(['dropped']);
  });

  it('keeps the recent instructions, not every one ever sent', async () => {
    const { client, runner } = setup();
    for (let i = 0; i < 30; i += 1) {
      await runner.send(`instruction ${i}`, { mode: 'steer', origin: 'user' });
      client.result();
      await tick();
    }
    expect(runner.queue).toHaveLength(20);
    expect(runner.queue.at(-1)?.text).toBe('instruction 29');
  });
});

describe('SessionRunner when a turn is stopped', () => {
  it('shows the instructions it was working on as never answered, not as done', async () => {
    const { client, runner } = setup();
    await runner.send('go a long way', { mode: 'steer', origin: 'user' });
    await tick();
    await runner.interrupt();
    await tick();
    expect(runner.queue.map((m) => [m.text, m.state])).toEqual([['go a long way', 'dropped']]);
    expect(runner.state).toBe('idle');
    void client;
  });

  it('is ready for the next instruction straight away', async () => {
    const { client, runner } = setup();
    await runner.send('first', { mode: 'steer', origin: 'user' });
    await tick();
    await runner.interrupt();
    await tick();
    expect(runner.state).toBe('idle');
    await runner.send('second', { mode: 'steer', origin: 'user' });
    await tick();
    expect(runner.state).toBe('running');
    expect(client.received.at(-1)?.text).toBe('second');
  });
});
