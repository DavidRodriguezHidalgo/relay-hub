import { describe, expect, it } from 'vitest';
import { ORCHESTRATOR_KEY, type BulkRun, type PendingApproval, type RunnerEvent } from '@relay/shared';
import { approvalMessage, notificationFor, statusMessage } from '../../src/telegram/notifications';

const titles: Record<string, { title: string; branch: string | null }> = {
  s1: { title: 'Add tests for the zero-rate case', branch: 'feat/zero' },
  s2: { title: 'Fix login', branch: null },
};
const ctx = { session: (id: string) => titles[id] ?? null };

const turnEnd = (over: Partial<Extract<RunnerEvent, { type: 'turn-end' }>>): RunnerEvent => ({
  type: 'turn-end', sessionId: 's1', origins: ['orchestrator'], lastText: 'Added 3 tests.', error: null, aborted: false, ...over,
});

describe('notificationFor', () => {
  it('reports a finished turn the orchestrator or the phone started, with the title and the last reply', () => {
    expect(notificationFor(turnEnd({}), ctx)).toBe('✔ Add tests for the zero-rate case (feat/zero) finished.\n\nAdded 3 tests.');
    expect(notificationFor(turnEnd({ origins: ['telegram'], sessionId: 's2', lastText: null }), ctx)).toBe('✔ Fix login finished.\n\n(no reply)');
  });

  it('stays quiet about turns typed into the session in the app, or started by a watch or a bulk row', () => {
    expect(notificationFor(turnEnd({ origins: ['user'] }), ctx)).toBeNull();
    expect(notificationFor(turnEnd({ origins: ['watch:ci_failed'] }), ctx)).toBeNull();
    expect(notificationFor(turnEnd({ origins: ['bulk:r1'] }), ctx)).toBeNull();
    expect(notificationFor(turnEnd({ origins: [] }), ctx)).toBeNull();
  });

  it('says when a delegated turn was stopped or failed', () => {
    expect(notificationFor(turnEnd({ aborted: true }), ctx)).toMatch(/^■ Add tests for the zero-rate case \(feat\/zero\) was stopped\./);
    expect(notificationFor(turnEnd({ error: 'process died' }), ctx)).toBe('✖ Add tests for the zero-rate case (feat/zero) failed: process died');
  });

  it("clips a long last reply and falls back to the id for a session it cannot name", () => {
    const text = notificationFor(turnEnd({ sessionId: 'gone', lastText: 'x'.repeat(400) }), ctx)!;
    expect(text.startsWith('✔ gone finished.')).toBe(true);
    expect(text.length).toBeLessThan(340);
    expect(text.endsWith('…')).toBe(true);
  });

  it("leaves the orchestrator's own turn ends alone: those are replies, handled elsewhere", () => {
    expect(notificationFor(turnEnd({ sessionId: ORCHESTRATOR_KEY, origins: ['telegram'] }), ctx)).toBeNull();
  });

  it('reports a failure once, from the turn that failed, never also from the state change', () => {
    // a failing runner emits both; two phone messages for one failure is exactly the noise to avoid
    expect(notificationFor(turnEnd({ error: 'expired login', lastText: null }), ctx)).toBe('✖ Add tests for the zero-rate case (feat/zero) failed: expired login');
    expect(notificationFor({ type: 'state', sessionId: 's1', state: 'error', error: 'expired login' }, ctx)).toBeNull();
    expect(notificationFor({ type: 'state', sessionId: 's2', state: 'running', error: null }, ctx)).toBeNull();
  });

  it('stays quiet about a failure in a session being driven from the app', () => {
    expect(notificationFor(turnEnd({ origins: ['user'], error: 'expired login' }), ctx)).toBeNull();
  });

  it('summarises a finished bulk run once, and says when one is waiting for the plan card', () => {
    const run: BulkRun = {
      id: 'r1', createdAt: '2026-09-30T10:00:00.000Z', mode: 'steer', status: 'finished',
      rows: [
        { sessionId: 's1', title: 'A', branch: 'a', prompt: 'p', status: 'done', detail: 'ok' },
        { sessionId: 's2', title: 'B', branch: null, prompt: 'p', status: 'error', detail: 'boom' },
        { sessionId: 's3', title: 'C', branch: null, prompt: 'p', status: 'skipped', detail: null },
      ],
    };
    expect(notificationFor({ type: 'bulk', run }, ctx)).toBe('Bulk run finished: 1 done, 1 error, 1 skipped.\n✖ B: boom');
    expect(notificationFor({ type: 'bulk', run: { ...run, status: 'proposed' } }, ctx)).toBe('Relay proposed a bulk run for 3 sessions. It waits for you to confirm the plan in the app.');
    expect(notificationFor({ type: 'bulk', run: { ...run, status: 'running' } }, ctx)).toBeNull();
    expect(notificationFor({ type: 'bulk', run: { ...run, status: 'cancelled' } }, ctx)).toBeNull();
  });

  it('ignores everything else', () => {
    const quiet: RunnerEvent[] = [
      { type: 'entry', sessionId: 's1', entry: { uuid: 'u', role: 'assistant', timestamp: 't', isSidechain: false, isMeta: false, blocks: [], origin: 'user' } },
      { type: 'queue', sessionId: 's1', queue: [] },
      { type: 'external', external: {} },
      { type: 'todos', todos: [] },
      { type: 'pr-event', sessionId: 's1', watchId: 'w', event: { kind: 'merged', summary: 'merged', details: 'd' } },
      { type: 'watch-removed', watchId: 'w', gh: { state: 'ok' } },
      { type: 'approval-resolved', approvalId: 'a', decision: 'deny' },
      { type: 'telegram', status: { botUsername: null, chatId: null, chatName: null, connection: 'ok', lastError: null, lastPolledAt: null, ignored: 0 } },
    ];
    for (const e of quiet) expect(notificationFor(e, ctx)).toBeNull();
  });
});

describe('approvalMessage', () => {
  const approval: PendingApproval = {
    id: 'a1', sessionId: 's1', toolName: 'Bash', input: { command: 'git push --force origin feat/zero' },
    summary: 'git push --force origin feat/zero', reason: 'destructive-git', cwd: '/c', createdAt: 't',
  };

  it('names the session, shows the command, and says why the phone may not allow it', () => {
    const text = approvalMessage(approval, { allowOnce: false, why: 'a plain force push can overwrite work; decide it at the machine' }, ctx);
    expect(text).toContain('Add tests for the zero-rate case (feat/zero) wants to run:');
    expect(text).toContain('git push --force origin feat/zero');
    expect(text).toContain('Allowing this needs the machine: a plain force push can overwrite work');
  });

  it('offers nothing about the machine when the phone may allow it', () => {
    const text = approvalMessage({ ...approval, summary: 'git rebase main' }, { allowOnce: true }, ctx);
    expect(text).not.toContain('needs the machine');
  });

  it('clips a very long command so the message still fits one Telegram message', () => {
    const text = approvalMessage({ ...approval, summary: 'x'.repeat(5000) }, { allowOnce: true }, ctx);
    expect(text.length).toBeLessThan(2000);
  });
});

describe('statusMessage', () => {
  const sessions = [
    { id: 's1', title: 'Add tests', branch: 'feat/zero' },
    { id: 's2', title: 'Fix login', branch: null },
    { id: 's3', title: 'Idle one', branch: 'x' },
  ];
  it('lists what is running, waiting and broken, and the approvals count', () => {
    const text = statusMessage({
      sessions,
      states: { s1: { state: 'running', error: null }, s2: { state: 'waiting-approval', error: null }, s3: { state: 'error', error: 'died' } },
      approvals: 1,
      orchestrator: 'running',
      bulkRunning: null,
    });
    expect(text).toBe(
      [
        'Running: Add tests (feat/zero)',
        'Waiting for approval: Fix login',
        'Error: Idle one (x) — died',
        '1 approval waiting on you.',
        'Relay chat is working on something.',
      ].join('\n'),
    );
  });

  it('says plainly when nothing is happening', () => {
    expect(statusMessage({ sessions, states: {}, approvals: 0, orchestrator: 'idle', bulkRunning: null })).toBe('Nothing is running.');
  });

  it('mentions a bulk run in progress', () => {
    const text = statusMessage({ sessions, states: {}, approvals: 0, orchestrator: 'idle', bulkRunning: { done: 2, total: 5 } });
    expect(text).toContain('Bulk run in progress: 2 of 5 done.');
  });
});
