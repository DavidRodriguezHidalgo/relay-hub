import { describe, expect, it } from 'vitest';
import type { SessionSummary } from '@relay/shared';
import { collisionFor, type Liveness } from './collisions';

const NOW = new Date('2026-09-24T12:00:00.000Z').getTime();
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const idle: Liveness = { states: {}, external: {}, now: NOW };

const s = (over: Partial<SessionSummary>): SessionSummary => ({
  id: 'x', filePath: '/f', cwd: '/code/app', cwdExists: true, repo: 'app', branch: 'main', title: 'T',
  lastActivity: ago(60_000), messageCount: 1, prNumber: null, prUrl: null, continuedIn: null, context: null, isStale: false, ...over,
});

describe('collisionFor', () => {
  it('finds another session recently active in the same directory', () => {
    const all = [s({ id: 'a', title: 'Alpha' }), s({ id: 'b', title: 'Beta' })];
    const hit = collisionFor(all, 'a', idle);
    expect(hit).toMatchObject({ kind: 'directory', cwd: '/code/app' });
    expect(hit?.others.map((o) => o.title)).toEqual(['Beta']);
  });

  it('ignores the pile of sessions that merely happened in that directory long ago', () => {
    const all = [
      s({ id: 'a' }),
      ...Array.from({ length: 30 }, (_, i) => s({ id: `old-${i}`, lastActivity: ago(3 * 60 * 60 * 1000) })),
    ];
    expect(collisionFor(all, 'a', idle)).toBeNull();
  });

  it('counts an old session that Relay is driving, or that is open in another Claude', () => {
    const old = { lastActivity: ago(24 * 60 * 60 * 1000) };
    const all = [s({ id: 'a' }), s({ id: 'b', title: 'Beta', ...old }), s({ id: 'c', title: 'Gamma', ...old })];
    expect(collisionFor(all, 'a', { ...idle, states: { b: { state: 'running', error: null } } })?.others.map((o) => o.title)).toEqual(['Beta']);
    expect(collisionFor(all, 'a', { ...idle, external: { c: 'busy' } })?.others.map((o) => o.title)).toEqual(['Gamma']);
  });

  it('finds sessions on one branch of one repository from different directories', () => {
    const all = [
      s({ id: 'a', cwd: '/code/app', branch: 'feat/x' }),
      s({ id: 'b', cwd: '/code/app-worktrees/feat-x', branch: 'feat/x' }),
    ];
    expect(collisionFor(all, 'a', idle)).toMatchObject({ kind: 'branch', branch: 'feat/x' });
  });

  it('does not pair a branch name shared across repositories', () => {
    const all = [s({ id: 'a', repo: 'app' }), s({ id: 'b', repo: 'other', cwd: '/o' })];
    expect(collisionFor(all, 'a', idle)).toBeNull();
  });

  it('ignores sessions that are stale, gone or continued elsewhere', () => {
    const all = [
      s({ id: 'a' }),
      s({ id: 'stale', isStale: true }),
      s({ id: 'gone', cwdExists: false }),
      s({ id: 'moved', continuedIn: 'z' }),
    ];
    expect(collisionFor(all, 'a', idle)).toBeNull();
  });

  it('keys the clash by who is in it, so dismissing it does not hide a new one', () => {
    const all = [s({ id: 'a' }), s({ id: 'b' })];
    const first = collisionFor(all, 'a', idle)!;
    const second = collisionFor([...all, s({ id: 'c' })], 'a', idle)!;
    expect(first.key).not.toBe(second.key);
    expect(collisionFor(all, 'a', idle)!.key).toBe(first.key);
  });

  it('has nothing to say about a session it does not know', () => {
    expect(collisionFor([s({ id: 'a' })], 'nope', idle)).toBeNull();
  });
});
