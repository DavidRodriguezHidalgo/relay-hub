import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BulkRun, PrWatch, SessionSummary } from '@relay/shared';
import { SessionStore } from '../../src/store/session-store';

const summary = (over: Partial<SessionSummary> = {}): SessionSummary => ({
  id: 's1', filePath: '/p/s1.jsonl', cwd: '/repo', cwdExists: true, repo: 'repo', branch: 'main',
  title: 'T', lastActivity: '2026-09-20T10:00:00.000Z', messageCount: 3, prNumber: null, prUrl: null,
  continuedIn: null, context: null, isStale: false, ...over,
});

describe('SessionStore', () => {
  it('round-trips a session and reports the cached file signature', () => {
    const store = new SessionStore(':memory:');
    store.upsert({ summary: summary(), mtimeMs: 10, size: 100 });
    expect(store.get('/p/s1.jsonl')).toEqual({ summary: summary(), mtimeMs: 10, size: 100 });
    expect(store.get('/p/none.jsonl')).toBeNull();
  });

  it('upsert replaces by file path', () => {
    const store = new SessionStore(':memory:');
    store.upsert({ summary: summary({ title: 'old' }), mtimeMs: 1, size: 1 });
    store.upsert({ summary: summary({ title: 'new' }), mtimeMs: 2, size: 2 });
    expect(store.all()).toHaveLength(1);
    expect(store.get('/p/s1.jsonl')?.summary.title).toBe('new');
  });

  it('removes sessions whose file is gone', () => {
    const store = new SessionStore(':memory:');
    store.upsert({ summary: summary(), mtimeMs: 1, size: 1 });
    store.upsert({ summary: summary({ id: 's2', filePath: '/p/s2.jsonl' }), mtimeMs: 1, size: 1 });
    store.removeMissing(['/p/s2.jsonl']);
    expect(store.all().map((c) => c.summary.id)).toEqual(['s2']);
  });

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

  it('saves bulk runs by id and loads the newest first', () => {
    const store = new SessionStore(':memory:');
    const run = (id: string, createdAt: string, status: BulkRun['status'] = 'proposed'): BulkRun => ({
      id, createdAt, mode: 'steer', status,
      rows: [{ sessionId: 's1', title: 'T', branch: null, prompt: 'p', status: 'proposed', detail: null }],
    });
    store.saveBulkRun(run('a', '2026-09-23T10:00:00.000Z'));
    store.saveBulkRun(run('b', '2026-09-23T11:00:00.000Z'));
    store.saveBulkRun(run('a', '2026-09-23T10:00:00.000Z', 'running'));
    expect(store.loadBulkRuns(10).map((r) => [r.id, r.status])).toEqual([['b', 'proposed'], ['a', 'running']]);
    expect(store.loadBulkRuns(1).map((r) => r.id)).toEqual(['b']);
  });

  it('saves, updates, loads and deletes PR watches with their snapshot', () => {
    const store = new SessionStore(':memory:');
    const w: PrWatch = {
      id: 'w1', sessionId: 's1', repo: 'o/r', prNumber: 7, prUrl: 'u', active: true,
      createdAt: '2026-09-23T10:00:00.000Z', lastPolledAt: null, lastError: null,
    };
    store.saveWatch(w, null);
    expect(store.loadWatches()).toEqual([{ watch: w, snapshot: null }]);
    store.saveWatch({ ...w, lastPolledAt: '2026-09-23T10:05:00.000Z' }, {
      state: 'OPEN', headRefOid: 'h', baseRefName: 'main', mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN',
      failingChecks: [], lastFeedbackAt: '',
    });
    const [loaded] = store.loadWatches();
    expect(loaded!.watch.lastPolledAt).toBe('2026-09-23T10:05:00.000Z');
    expect(loaded!.snapshot?.headRefOid).toBe('h');
    store.deleteWatch('w1');
    expect(store.loadWatches()).toEqual([]);
  });

  it("keeps only the newest 50 bulk runs on disk", () => {
    const store = new SessionStore(":memory:");
    for (let i = 0; i < 55; i += 1) {
      store.saveBulkRun({ id: "r" + i, createdAt: "2026-09-23T10:" + String(i).padStart(2, "0") + ":00.000Z", mode: "steer", status: "finished", rows: [] });
    }
    const runs = store.loadBulkRuns(100);
    expect(runs).toHaveLength(50);
    expect(runs.at(-1)!.id).toBe("r5");
  });
  it('remembers which kinds of call a session allows, without duplicating them', () => {
    const store = new SessionStore(':memory:');
    store.allowPattern('s1', 'Bash path /repo');
    store.allowPattern('s1', 'Bash path /repo');
    store.allowPattern('s2', 'Bash git push');
    expect(store.allowedPatterns()).toEqual([
      { sessionId: 's1', patternKey: 'Bash path /repo' },
      { sessionId: 's2', patternKey: 'Bash git push' },
    ]);
    store.close();
  });
});
