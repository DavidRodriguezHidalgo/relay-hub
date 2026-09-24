import { describe, expect, it } from 'vitest';
import type { SessionSummary } from '@relay/shared';
import { collisionFor } from './collisions';

const s = (over: Partial<SessionSummary>): SessionSummary => ({
  id: 'x', filePath: '/f', cwd: '/code/app', cwdExists: true, repo: 'app', branch: 'main', title: 'T',
  lastActivity: '2026-09-24T10:00:00.000Z', messageCount: 1, prNumber: null, prUrl: null, continuedIn: null,
  isStale: false, ...over,
});

describe('collisionFor', () => {
  it('finds the other sessions working in the same directory', () => {
    const all = [s({ id: 'a', title: 'Alpha' }), s({ id: 'b', title: 'Beta' }), s({ id: 'c', cwd: '/code/other' })];
    const hit = collisionFor(all, 'a');
    expect(hit).toMatchObject({ kind: 'directory', cwd: '/code/app' });
    expect(hit?.others.map((o) => o.title)).toEqual(['Beta']);
  });

  it('finds sessions on the same branch of the same repository, in different directories', () => {
    const all = [
      s({ id: 'a', cwd: '/code/app', branch: 'feat/x' }),
      s({ id: 'b', cwd: '/code/app-worktrees/feat-x', branch: 'feat/x' }),
    ];
    expect(collisionFor(all, 'a')).toMatchObject({ kind: 'branch', branch: 'feat/x' });
  });

  it('says nothing when a session has the place to itself', () => {
    expect(collisionFor([s({ id: 'a' }), s({ id: 'b', cwd: '/elsewhere', branch: 'other' })], 'a')).toBeNull();
  });

  it('ignores sessions that are stale, gone, or continued elsewhere', () => {
    const all = [
      s({ id: 'a' }),
      s({ id: 'stale', isStale: true, title: 'Stale' }),
      s({ id: 'gone', cwdExists: false, title: 'Gone' }),
      s({ id: 'moved', continuedIn: 'z', title: 'Moved' }),
    ];
    expect(collisionFor(all, 'a')).toBeNull();
  });

  it('prefers the directory clash, which is the one that loses work', () => {
    const all = [s({ id: 'a', branch: 'feat/x' }), s({ id: 'b', branch: 'feat/x' })];
    expect(collisionFor(all, 'a')?.kind).toBe('directory');
  });

  it('has nothing to say about a session it does not know', () => {
    expect(collisionFor([s({ id: 'a' })], 'nope')).toBeNull();
  });

  it('does not pair sessions that merely share a branch name across repositories', () => {
    const all = [s({ id: 'a', repo: 'app', branch: 'main' }), s({ id: 'b', repo: 'other', cwd: '/o', branch: 'main' })];
    expect(collisionFor(all, 'a')).toBeNull();
  });
});
