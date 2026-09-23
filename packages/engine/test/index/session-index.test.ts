import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendFile, chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SessionIndex } from '../../src/index/session-index';
import { SessionStore } from '../../src/store/session-store';
import type { GitInfoProvider } from '../../src/git/git-info';

const fixture = (name: string) => fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));

class FakeGit implements GitInfoProvider {
  calls: string[] = [];
  async inspect(cwd: string) {
    this.calls.push(cwd);
    return { branch: 'feat/live', repo: 'myrepo' };
  }
}

describe('SessionIndex', () => {
  let root: string;
  let projectsDir: string;
  let cwdA: string;
  let git: FakeGit;
  let store: SessionStore;
  let index: SessionIndex | null = null;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'relay-index-'));
    projectsDir = join(root, 'projects');
    cwdA = join(root, 'wt-a');
    await mkdir(join(projectsDir, 'proj-a', 'subagents'), { recursive: true });
    await mkdir(cwdA);
    // basic.jsonl points at /repo/wt-a; rewrite cwd so it exists on this machine
    const basic = await readFile(fixture('basic.jsonl'), 'utf8');
    await writeFile(join(projectsDir, 'proj-a', 's-basic.jsonl'), basic.replaceAll('/repo/wt-a', cwdA));
    await copyFile(fixture('no-prompt.jsonl'), join(projectsDir, 'proj-a', 's-noprompt.jsonl'));
    await writeFile(join(projectsDir, 'proj-a', 'subagents', 'agent-1.jsonl'), '{"type":"user"}\n');
    await writeFile(join(projectsDir, 'proj-a', 'notes.txt'), 'ignore me');
    git = new FakeGit();
    store = new SessionStore(':memory:');
  });

  afterEach(async () => {
    await index?.close();
    index = null;
    store.close();
    await rm(root, { recursive: true, force: true });
  });

  const make = (now = new Date('2026-09-23T00:00:00.000Z')) =>
    (index = new SessionIndex({ projectsDir, store, git, now: () => now, debounceMs: 20 }));

  it('indexes only session transcripts and ignores stray files', async () => {
    const sessions = await make().scan();
    expect(sessions.map((s) => s.id)).toEqual(['s-noprompt', 's-basic']);
  });

  it('uses live git info for an existing cwd and marks it fresh', async () => {
    const [, basic] = await make().scan();
    expect(basic).toMatchObject({
      id: 's-basic', cwd: cwdA, cwdExists: true, repo: 'myrepo', branch: 'feat/a',
      title: 'Add tests for the zero-rate case', prNumber: 42, isStale: false, messageCount: 4,
    });
    expect(git.calls).toEqual([cwdA]);
  });

  it('marks a missing cwd stale without calling git', async () => {
    const [noPrompt] = await make().scan();
    expect(noPrompt).toMatchObject({
      id: 's-noprompt', cwd: '/repo/wt-c-moved', cwdExists: false, branch: null, repo: 'wt-c-moved', isStale: true,
    });
    expect(git.calls).not.toContain('/repo/wt-c-moved');
  });

  it('marks sessions older than 30 days stale', async () => {
    const [, basic] = await make(new Date('2026-11-01T00:00:00.000Z')).scan();
    expect(basic?.isStale).toBe(true);
  });

  it('re-parses only changed files on a second scan', async () => {
    // a second session in the same (existing) cwd: re-parsing it too would call git twice
    const basic = await readFile(fixture('basic.jsonl'), 'utf8');
    await writeFile(
      join(projectsDir, 'proj-a', 's-other.jsonl'),
      basic.replaceAll('/repo/wt-a', cwdA).replaceAll('s-basic', 's-other'),
    );
    const idx = make();
    await idx.scan();
    git.calls = [];
    await appendFile(
      join(projectsDir, 'proj-a', 's-basic.jsonl'),
      '\n{"type":"assistant","uuid":"a9","isSidechain":false,"timestamp":"2026-09-22T10:00:00.000Z","cwd":"' + cwdA + '","sessionId":"s-basic","message":{"role":"assistant","content":[{"type":"text","text":"later"}]}}',
    );
    const sessions = await idx.scan();
    expect(sessions.find((s) => s.id === 's-basic')?.messageCount).toBe(5);
    expect(git.calls).toEqual([cwdA]); // no-prompt session was served from cache
  });

  it('notices a worktree deleted after the session was cached', async () => {
    const idx = make();
    await idx.scan();
    await rm(cwdA, { recursive: true });
    const [, basic] = await idx.scan();
    expect(basic).toMatchObject({ id: 's-basic', cwdExists: false, branch: null, isStale: true });
    // and the reverse: the worktree comes back
    await mkdir(cwdA);
    const [, again] = await idx.scan();
    expect(again).toMatchObject({ id: 's-basic', cwdExists: true, branch: 'feat/a', repo: 'myrepo', isStale: false });
  });

  it('keeps indexing when one transcript cannot be read', async () => {
    const bad = join(projectsDir, 'proj-a', 's-bad.jsonl');
    await writeFile(bad, '{"type":"user"}\n');
    await chmod(bad, 0o000);
    const sessions = await make().scan();
    expect(sessions.map((s) => s.id)).toEqual(['s-noprompt', 's-basic']);
  });

  it('returns the transcript entries for a session', async () => {
    const idx = make();
    await idx.scan();
    const entries = await idx.getTranscript('s-basic');
    expect(entries.map((e) => e.uuid)).toEqual(['u1', 'a1', 'u2', 'side1', 'a2']);
  });

  it('emits one changed event after a burst of writes', async () => {
    const idx = make();
    await idx.scan();
    const events: number[] = [];
    idx.on('changed', (s) => events.push(s.length));
    idx.watch();
    await new Promise((r) => setTimeout(r, 100));
    const file = join(projectsDir, 'proj-a', 's-basic.jsonl');
    await appendFile(file, '\n{"type":"mode","mode":"normal","sessionId":"s-basic"}');
    await appendFile(file, '\n{"type":"mode","mode":"normal","sessionId":"s-basic"}');
    await new Promise((r) => setTimeout(r, 400));
    expect(events).toEqual([2]);
  });
});
