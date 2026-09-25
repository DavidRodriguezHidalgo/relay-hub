import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { branchWork } from '../../src/git/branch-work';

const run = promisify(execFile);
const git = (cwd: string, ...args: string[]) =>
  run('git', ['-C', cwd, '-c', 'user.email=t@t', '-c', 'user.name=T', ...args]);

describe('branchWork', () => {
  let root: string;
  let repo: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'relay-bw-'));
    repo = join(root, 'repo');
    await run('git', ['init', '-q', '-b', 'main', repo]);
    await writeFile(join(repo, 'base.txt'), 'base');
    await git(repo, 'add', '.');
    await git(repo, 'commit', '-q', '-m', 'base commit');
  });
  afterEach(() => rm(root, { recursive: true, force: true }));

  it('lists what a branch added over its base, newest first, with the files touched', async () => {
    await git(repo, 'checkout', '-q', '-b', 'feat/x');
    await writeFile(join(repo, 'a.ts'), 'one');
    await git(repo, 'add', '.');
    await git(repo, 'commit', '-q', '-m', 'add a');
    await writeFile(join(repo, 'b.ts'), 'two');
    await git(repo, 'add', '.');
    await git(repo, 'commit', '-q', '-m', 'add b');

    const work = await branchWork(repo);
    expect(work.base).toBe('main');
    expect(work.commits.map((c) => c.subject)).toEqual(['add b', 'add a']);
    expect(work.commits[0]?.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(work.files).toEqual(['a.ts', 'b.ts']);
    expect(work.moreFiles).toBe(0);
  });

  it('counts uncommitted files as touched too, since they are part of the work', async () => {
    await git(repo, 'checkout', '-q', '-b', 'feat/x');
    await writeFile(join(repo, 'wip.ts'), 'not committed');
    const work = await branchWork(repo);
    expect(work.files).toContain('wip.ts');
  });

  it('says nothing was added when the branch is level with its base', async () => {
    await git(repo, 'checkout', '-q', '-b', 'feat/x');
    const work = await branchWork(repo);
    expect(work.base).toBe('main');
    expect(work.commits).toEqual([]);
    expect(work.note).toBeNull();
  });

  it('says so when there is no other branch to compare against at all', async () => {
    const work = await branchWork(repo);
    expect(work.note).toMatch(/no other branch/i);
  });

  it('caps a long list of files and says how many more there were', async () => {
    await git(repo, 'checkout', '-q', '-b', 'feat/x');
    for (let i = 0; i < 40; i += 1) await writeFile(join(repo, `f${i}.ts`), String(i));
    await git(repo, 'add', '.');
    await git(repo, 'commit', '-q', '-m', 'many');
    const work = await branchWork(repo);
    expect(work.files).toHaveLength(20);
    expect(work.moreFiles).toBe(20);
  });

  it('explains itself for a directory that is not a repository', async () => {
    const work = await branchWork(root);
    expect(work.commits).toEqual([]);
    expect(work.note).toMatch(/not a git/i);
  });
});
