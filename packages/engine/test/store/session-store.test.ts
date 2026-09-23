import { describe, expect, it } from 'vitest';
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
});
