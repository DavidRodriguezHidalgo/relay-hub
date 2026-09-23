import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SessionSummary } from '@relay/shared';
import { SessionStore } from '../../src/store/session-store';

const summary = (over: Partial<SessionSummary> = {}): SessionSummary => ({
  id: 's1', filePath: '/p/s1.jsonl', cwd: '/repo', cwdExists: true, repo: 'repo', branch: 'main',
  title: 'T', lastActivity: '2026-09-20T10:00:00.000Z', messageCount: 3, prNumber: null, prUrl: null,
  continuedIn: null, isStale: false, ...over,
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
});
