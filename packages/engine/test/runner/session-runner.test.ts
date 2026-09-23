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
