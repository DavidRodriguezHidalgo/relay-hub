import { describe, expect, it } from 'vitest';
import type { SessionSummary } from '@relay/shared';
import { groupSessions } from './groupSessions';

const s = (over: Partial<SessionSummary>): SessionSummary => ({
  id: 'x', filePath: '/f', cwd: '/c', cwdExists: true, repo: 'repo', branch: 'main', title: 'T',
  lastActivity: '2026-09-20T00:00:00.000Z', messageCount: 1, prNumber: null, prUrl: null, continuedIn: null,
  isStale: false, ...over,
});

describe('groupSessions', () => {
  it('groups by repo, ordering groups by their newest session', () => {
    const groups = groupSessions(
      [
        s({ id: 'a', repo: 'old', lastActivity: '2026-09-01T00:00:00.000Z' }),
        s({ id: 'b', repo: 'new', lastActivity: '2026-09-20T00:00:00.000Z' }),
        s({ id: 'c', repo: 'old', lastActivity: '2026-09-10T00:00:00.000Z' }),
      ],
      { query: '', showStale: true },
    );
    expect(groups.map((g) => g.repo)).toEqual(['new', 'old']);
    expect(groups[1]?.sessions.map((x) => x.id)).toEqual(['c', 'a']);
  });

  it('hides stale sessions unless asked', () => {
    const list = [s({ id: 'fresh' }), s({ id: 'stale', isStale: true })];
    expect(groupSessions(list, { query: '', showStale: false })[0]?.sessions.map((x) => x.id)).toEqual(['fresh']);
    expect(groupSessions(list, { query: '', showStale: true })[0]?.sessions).toHaveLength(2);
  });

  it('filters by title, branch and repo, case-insensitively', () => {
    const list = [s({ id: 'a', title: 'Mileage claims' }), s({ id: 'b', branch: 'feat/ocr' }), s({ id: 'c', repo: 'Other' })];
    expect(groupSessions(list, { query: 'MILEAGE', showStale: true }).flatMap((g) => g.sessions.map((x) => x.id))).toEqual(['a']);
    expect(groupSessions(list, { query: 'ocr', showStale: true }).flatMap((g) => g.sessions.map((x) => x.id))).toEqual(['b']);
    expect(groupSessions(list, { query: 'other', showStale: true }).flatMap((g) => g.sessions.map((x) => x.id))).toEqual(['c']);
  });
});
