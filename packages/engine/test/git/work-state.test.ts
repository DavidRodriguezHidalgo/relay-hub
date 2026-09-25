import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { workState } from '../../src/git/work-state';

const run = promisify(execFile);
const git = (cwd: string, ...args: string[]) =>
  run('git', ['-C', cwd, '-c', 'user.email=t@t', '-c', 'user.name=T', ...args]);

describe('workState', () => {
  let root: string;
  let repo: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'relay-ws-'));
    repo = join(root, 'repo');
    await run('git', ['init', '-q', '-b', 'main', repo]);
    await writeFile(join(repo, 'a.txt'), 'one');
    await git(repo, 'add', '.');
    await git(repo, 'commit', '-q', '-m', 'first commit');
  });
  afterEach(() => rm(root, { recursive: true, force: true }));

  it('reports the branch and the last commit', async () => {
    const s = await workState(repo);
    expect(s.branch).toBe('main');
    expect(s.lastCommit?.subject).toBe('first commit');
    expect(s.lastCommit?.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(Date.parse(s.lastCommit!.at)).not.toBeNaN();
    expect(s.uncommitted).toBe(0);
  });

  it('counts what has been changed but not committed', async () => {
    await writeFile(join(repo, 'a.txt'), 'changed');
    await writeFile(join(repo, 'b.txt'), 'new');
    expect((await workState(repo)).uncommitted).toBe(2);
  });

  it('counts commits the remote does not have', async () => {
    const origin = join(root, 'origin.git');
    await run('git', ['init', '-q', '--bare', origin]);
    await git(repo, 'remote', 'add', 'origin', origin);
    await git(repo, 'push', '-q', '-u', 'origin', 'main');
    expect(await workState(repo)).toMatchObject({ unpushed: 0, upstream: 'origin/main' });

    await writeFile(join(repo, 'c.txt'), 'later');
    await git(repo, 'add', '.');
    await git(repo, 'commit', '-q', '-m', 'second');
    expect((await workState(repo)).unpushed).toBe(1);
  });

  it('says nothing is tracking when a branch has no upstream', async () => {
    expect(await workState(repo)).toMatchObject({ upstream: null, unpushed: 0 });
  });

  it('answers for a directory that is not a repository at all', async () => {
    expect(await workState(root)).toEqual({ branch: null, lastCommit: null, uncommitted: 0, unpushed: 0, upstream: null });
  });
});
