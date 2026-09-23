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
    void q.request({
      sessionId: 's2', toolName: 'Bash', input: { command: 'git push -f' }, cwd, signal: new AbortController().signal,
    });
    expect(q.pending().map((p) => p.sessionId)).toEqual(['s2']);
    // and after forgetSession, s1 asks again
    q.forgetSession('s1');
    void req(q, 'git push -f origin c');
    expect(q.pending().map((p) => p.sessionId)).toEqual(['s2', 's1']);
  });

  it('allow-pattern covers the destructive step, not whatever the line started with', async () => {
    const q = new ApprovalQueue();
    const first = req(q, 'git fetch && git reset --hard origin/main');
    q.decide(q.pending()[0]!.id, { kind: 'allow-pattern' });
    expect(await first).toEqual({ behavior: 'allow' });
    // same head, different destructive step: asks
    void req(q, 'git fetch && git push -f origin +main');
    expect(q.pending().map((p) => p.summary)).toEqual(['git fetch && git push -f origin +main']);
    q.decide(q.pending()[0]!.id, { kind: 'deny' });
    // same destructive step behind a different head: allowed
    expect(await req(q, 'git pull && git reset --hard origin/x')).toEqual({ behavior: 'allow' });
  });

  it('allow-pattern for a file outside the cwd covers only that directory', async () => {
    const q = new ApprovalQueue();
    const edit = (file_path: string) =>
      q.request({ sessionId: 's1', toolName: 'Edit', input: { file_path }, cwd, signal: new AbortController().signal });
    const first = edit('/other/lib/a.ts');
    q.decide(q.pending()[0]!.id, { kind: 'allow-pattern' });
    expect(await first).toEqual({ behavior: 'allow' });
    expect(await edit('/other/lib/b.ts')).toEqual({ behavior: 'allow' });
    void edit('/Users/me/.zshrc');
    expect(q.pending()).toHaveLength(1);
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
