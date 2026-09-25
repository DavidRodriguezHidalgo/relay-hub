import { describe, expect, it } from 'vitest';
import type { SessionSummary } from '@relay/shared';
import { RECENT_WINDOW_MS, recentSessions, type RecencyOptions } from './recentSessions';

const NOW = Date.parse('2026-09-25T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const HOUR = 60 * 60 * 1000;

const s = (over: Partial<SessionSummary>): SessionSummary => ({
  id: 'x', filePath: '/f', cwd: '/c', cwdExists: true, repo: 'repo', branch: 'main', title: 'T',
  lastActivity: ago(HOUR), messageCount: 1, prNumber: null, prUrl: null, continuedIn: null,
  context: null, isStale: false, ...over,
});

const split = (sessions: SessionSummary[], over: Partial<RecencyOptions> = {}) =>
  recentSessions(sessions, { now: NOW, searching: false, showAll: false, selectedId: null, ...over });

describe('recentSessions', () => {
  it('keeps sessions inside the window and holds back older ones', () => {
    const recent = [1, 2, 3, 4, 5].map((n) => s({ id: `recent${n}`, lastActivity: ago(n * HOUR) }));
    const out = split([
      ...recent,
      s({ id: 'lastWeek', lastActivity: ago(7 * 24 * HOUR) }),
      s({ id: 'lastMonth', lastActivity: ago(30 * 24 * HOUR) }),
    ]);
    expect(out.shown.map((x) => x.id)).toEqual(['recent1', 'recent2', 'recent3', 'recent4', 'recent5']);
    expect(out.hidden).toBe(2);
  });

  it('treats the window edge as still recent', () => {
    const out = split([s({ id: 'edge', lastActivity: ago(RECENT_WINDOW_MS) })]);
    expect(out.shown.map((x) => x.id)).toEqual(['edge']);
  });

  it('never hides a session that is running, however old', () => {
    const out = split([s({ id: 'ancient', lastActivity: ago(90 * 24 * HOUR) })], {
      states: { ancient: { state: 'running', error: null } },
    });
    expect(out.shown.map((x) => x.id)).toEqual(['ancient']);
    expect(out.hidden).toBe(0);
  });

  it('never hides a session waiting on an approval, however old', () => {
    const out = split([s({ id: 'ancient', lastActivity: ago(90 * 24 * HOUR) })], {
      states: { ancient: { state: 'waiting-approval', error: null } },
    });
    expect(out.shown.map((x) => x.id)).toEqual(['ancient']);
  });

  it('never hides a session another process is running', () => {
    const out = split([s({ id: 'ancient', lastActivity: ago(90 * 24 * HOUR) })], {
      external: { ancient: 'busy' },
    });
    expect(out.shown.map((x) => x.id)).toEqual(['ancient']);
  });

  it('never hides the session being read, so the open one cannot vanish', () => {
    const out = split([s({ id: 'ancient', lastActivity: ago(90 * 24 * HOUR) })], { selectedId: 'ancient' });
    expect(out.shown.map((x) => x.id)).toEqual(['ancient']);
    expect(out.hidden).toBe(0);
  });

  it('shows everything once asked, and then holds nothing back', () => {
    const out = split([s({ id: 'old', lastActivity: ago(90 * 24 * HOUR) })], { showAll: true });
    expect(out.shown).toHaveLength(1);
    expect(out.hidden).toBe(0);
  });

  it('searches the whole history, not just the recent window', () => {
    const out = split([s({ id: 'old', lastActivity: ago(90 * 24 * HOUR) })], { searching: true });
    expect(out.shown.map((x) => x.id)).toEqual(['old']);
    expect(out.hidden).toBe(0);
  });

  it('counts honestly when several are held back', () => {
    const old = [1, 2, 3, 4, 5, 6, 7, 8].map((n) =>
      s({ id: `old${n}`, lastActivity: new Date(NOW - (200 + n) * HOUR).toISOString() }),
    );
    const out = split([s({ id: 'fresh' }), ...old]);
    // four older ones top the list up to the floor; the rest are hidden and counted
    expect(out.shown.map((x) => x.id)).toEqual(['fresh', 'old1', 'old2', 'old3', 'old4']);
    expect(out.hidden).toBe(4);
  });

  it('never leaves the panel empty when everything is old', () => {
    const old = [1, 2, 3].map((n) => s({ id: `old${n}`, lastActivity: ago(500 * HOUR) }));
    const out = split(old);
    expect(out.shown).toHaveLength(3);
    expect(out.hidden).toBe(0);
  });

  it('tops up with the newest of the old ones, not an arbitrary few', () => {
    const out = split([
      s({ id: 'oldest', lastActivity: ago(900 * HOUR) }),
      s({ id: 'newer', lastActivity: ago(100 * HOUR) }),
      s({ id: 'middle', lastActivity: ago(500 * HOUR) }),
      s({ id: 'a', lastActivity: ago(800 * HOUR) }),
      s({ id: 'b', lastActivity: ago(700 * HOUR) }),
      s({ id: 'c', lastActivity: ago(600 * HOUR) }),
    ]);
    expect(out.shown.map((x) => x.id)).toEqual(['newer', 'middle', 'a', 'b', 'c']);
    expect(out.hidden).toBe(1);
  });

  it('leaves the order it was given, so grouping still decides the arrangement', () => {
    const out = split([s({ id: 'b' }), s({ id: 'a' })]);
    expect(out.shown.map((x) => x.id)).toEqual(['b', 'a']);
  });
});
