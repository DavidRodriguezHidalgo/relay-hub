import { describe, expect, it } from 'vitest';
import type { BulkRun } from '@relay/shared';
import { BulkRuns, bulkOrigin, repairLoadedRuns } from '../../src/bulk/bulk-runs';

const tick = () => new Promise((r) => setTimeout(r, 0));
const targets = (...ids: string[]) =>
  ids.map((id) => ({ sessionId: id, title: `T-${id}`, branch: `b-${id}`, prompt: `do ${id}` }));

function setup(concurrency = 3, refuse: Record<string, string> = {}) {
  const sent: { sessionId: string; origin: string }[] = [];
  const runs = new BulkRuns({
    concurrency,
    now: () => new Date('2026-09-23T12:00:00.000Z'),
    send: async (req) => {
      if (refuse[req.sessionId]) throw new Error(refuse[req.sessionId]);
      sent.push({ sessionId: req.sessionId, origin: req.origin });
      return `m-${req.sessionId}`;
    },
  });
  const changes: BulkRun[] = [];
  const finished: BulkRun[] = [];
  runs.on('changed', (r) => changes.push(r));
  runs.on('finished', (r) => finished.push(r));
  return { runs, sent, changes, finished };
}

const statuses = (r: BulkRun) => r.rows.map((x) => `${x.sessionId}:${x.status}`);
const done = (runs: BulkRuns, runId: string, sessionId: string, text = 'ok') =>
  runs.onTurnEnd(sessionId, { origins: [bulkOrigin(runId)], lastText: text, error: null });

describe('BulkRuns', () => {
  it('proposes a run with every row proposed and sends nothing', () => {
    const { runs, sent } = setup();
    const run = runs.propose(targets('a', 'b'), 'steer');
    expect(run).toMatchObject({ status: 'proposed', mode: 'steer', createdAt: '2026-09-23T12:00:00.000Z' });
    expect(statuses(run)).toEqual(['a:proposed', 'b:proposed']);
    expect(sent).toEqual([]);
  });

  it('confirm skips unticked rows and starts at most `concurrency` rows, the rest queued', async () => {
    const { runs, sent } = setup(2);
    const run = runs.propose(targets('a', 'b', 'c', 'd'), 'steer');
    runs.confirm(run.id, ['a', 'b', 'c']);
    await tick();
    const now = runs.recent(1)[0]!;
    expect(now.status).toBe('running');
    expect(statuses(now)).toEqual(['a:running', 'b:running', 'c:queued', 'd:skipped']);
    expect(sent).toEqual([
      { sessionId: 'a', origin: `bulk:${run.id}` },
      { sessionId: 'b', origin: `bulk:${run.id}` },
    ]);
  });

  it('a finished row starts the next queued one; the run finishes once every row is settled', async () => {
    const { runs, sent, finished } = setup(1);
    const run = runs.propose(targets('a', 'b'), 'steer');
    runs.confirm(run.id, ['a', 'b']);
    await tick();
    done(runs, run.id, 'a', 'Added tests.');
    await tick();
    expect(sent.map((s) => s.sessionId)).toEqual(['a', 'b']);
    expect(finished).toEqual([]);
    runs.onTurnEnd('b', { origins: [bulkOrigin(run.id)], lastText: null, error: 'api error' });
    await tick();
    const last = runs.recent(1)[0]!;
    expect(last.status).toBe('finished');
    expect(last.rows.map((r) => [r.status, r.detail])).toEqual([['done', 'Added tests.'], ['error', 'api error']]);
    expect(finished).toHaveLength(1);
  });

  it('a refused send marks only that row as error and the rest go on', async () => {
    const { runs, sent } = setup(3, { b: 'Session b is open in another Claude process (pid 7)' });
    const run = runs.propose(targets('a', 'b', 'c'), 'steer');
    runs.confirm(run.id, ['a', 'b', 'c']);
    await tick();
    const now = runs.recent(1)[0]!;
    expect(statuses(now)).toEqual(['a:running', 'b:error', 'c:running']);
    expect(now.rows[1]!.detail).toBe('Session b is open in another Claude process (pid 7)');
    expect(sent.map((s) => s.sessionId)).toEqual(['a', 'c']);
  });

  it('ignores turn-ends that are not from this run, and recognises its origin among others', async () => {
    const { runs } = setup();
    const run = runs.propose(targets('a'), 'steer');
    runs.confirm(run.id, ['a']);
    await tick();
    runs.onTurnEnd('a', { origins: ['user'], lastText: 'x', error: null });
    expect(statuses(runs.recent(1)[0]!)).toEqual(['a:running']);
    runs.onTurnEnd('a', { origins: ['user', bulkOrigin(run.id)], lastText: 'y', error: null });
    expect(statuses(runs.recent(1)[0]!)).toEqual(['a:done']);
  });

  it('confirming with nothing ticked cancels the run', async () => {
    const { runs, sent, finished } = setup();
    const run = runs.propose(targets('a', 'b'), 'steer');
    runs.confirm(run.id, []);
    await tick();
    expect(runs.recent(1)[0]!.status).toBe('cancelled');
    expect(sent).toEqual([]);
    expect(finished).toEqual([]);
  });

  it('cancel, double confirm and unknown ids throw and change nothing', async () => {
    const { runs } = setup();
    const run = runs.propose(targets('a'), 'steer');
    expect(() => runs.confirm('nope', ['a'])).toThrow(/unknown bulk run/i);
    runs.cancel(run.id);
    expect(runs.recent(1)[0]!.status).toBe('cancelled');
    expect(() => runs.confirm(run.id, ['a'])).toThrow(/not waiting for confirmation/i);
    expect(() => runs.cancel(run.id)).toThrow(/not waiting for confirmation/i);
  });

  it('emits a changed snapshot on every transition and never exposes its internal objects', async () => {
    const { runs, changes } = setup();
    const run = runs.propose(targets('a'), 'steer');
    run.rows[0]!.status = 'done'; // mutating the returned snapshot must not leak in
    runs.confirm(run.id, ['a']);
    await tick();
    expect(changes.map((c) => c.status)).toEqual(['proposed', 'running', 'running']);
    expect(runs.recent(1)[0]!.rows[0]!.status).toBe('running');
  });
});

describe('repairLoadedRuns', () => {
  it('finishes runs that were running when Relay closed and cancels unconfirmed ones', () => {
    const row = (status: BulkRun['rows'][number]['status']) => ({ sessionId: status, title: 't', branch: null, prompt: 'p', status, detail: null });
    const repaired = repairLoadedRuns([
      { id: 'r1', createdAt: 'x', mode: 'steer', status: 'running', rows: [row('done'), row('running'), row('queued')] },
      { id: 'r2', createdAt: 'x', mode: 'steer', status: 'proposed', rows: [row('proposed')] },
      { id: 'r3', createdAt: 'x', mode: 'steer', status: 'finished', rows: [row('done')] },
    ]);
    expect(repaired.map((r) => r.status)).toEqual(['finished', 'cancelled', 'finished']);
    expect(repaired[0]!.rows.map((r) => [r.status, r.detail])).toEqual([
      ['done', null],
      ['error', 'Relay was closed during the run'],
      ['error', 'Relay was closed during the run'],
    ]);
  });
});
