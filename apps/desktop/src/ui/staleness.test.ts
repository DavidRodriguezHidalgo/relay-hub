import { describe, expect, it } from 'vitest';
import type { SessionSummary } from '@relay/shared';
import { stalenessOf } from './staleness';

const s = (over: Partial<SessionSummary>): SessionSummary => ({
  id: 'a', filePath: '/f', cwd: '/code/app', cwdExists: true, repo: 'app', branch: 'feat/a', title: 'T',
  lastActivity: '2026-09-25T10:00:00.000Z', messageCount: 10, prNumber: null, prUrl: null, continuedIn: null,
  isStale: false, ...over,
});
const none = { missingChannels: 0, shown: s({}), current: s({}) };

describe('stalenessOf', () => {
  it('says nothing when what is shown matches what is on disk', () => {
    expect(stalenessOf(none)).toBeNull();
  });

  it('puts the app process first, since nothing else works until it is restarted', () => {
    const hit = stalenessOf({ ...none, missingChannels: 3, current: s({ cwd: '/moved' }) });
    expect(hit).toMatchObject({ kind: 'process' });
    expect(hit?.message).toMatch(/Restart the app/);
  });

  it('names a directory that has gone', () => {
    const hit = stalenessOf({ ...none, current: s({ cwdExists: false }) });
    expect(hit).toMatchObject({ kind: 'moved' });
    expect(hit?.message).toContain('/code/app');
  });

  it('names a session that moved to another directory', () => {
    const hit = stalenessOf({ ...none, current: s({ cwd: '/code/app-worktrees/feat-a' }) });
    expect(hit).toMatchObject({ kind: 'directory' });
    expect(hit?.message).toContain('/code/app-worktrees/feat-a');
  });

  it('names a branch that changed underneath it', () => {
    const hit = stalenessOf({ ...none, current: s({ branch: 'main' }) });
    expect(hit).toMatchObject({ kind: 'branch' });
    expect(hit?.message).toMatch(/feat\/a to main/);
  });

  it('says when the conversation has gone on since the panel was drawn', () => {
    expect(stalenessOf({ ...none, current: s({ messageCount: 12 }) })).toMatchObject({ kind: 'transcript' });
    expect(stalenessOf({ ...none, current: s({ lastActivity: '2026-09-25T11:00:00.000Z' }) })).toMatchObject({ kind: 'transcript' });
  });

  it('has nothing to say about a session it has not read', () => {
    expect(stalenessOf({ missingChannels: 0, shown: null, current: s({}) })).toBeNull();
  });
});
