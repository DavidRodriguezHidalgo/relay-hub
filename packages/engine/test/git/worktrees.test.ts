import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createWorktree, repoRoot, worktreePath } from '../../src/git/worktrees';

const run = promisify(execFile);
const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const git = (cwd: string, ...args: string[]) => run('git', ['-C', cwd, ...args], { env });

describe('worktrees', () => {
  let root: string;
  let clone: string;
  beforeAll(async () => {
    // real path: on macOS tmpdir() is under the /var -> /private/var symlink, and git reports real paths
    root = await realpath(await mkdtemp(join(tmpdir(), 'relay-wt-')));
    const origin = join(root, 'origin.git');
    await run('git', ['init', '-q', '--bare', '-b', 'main', origin]);
    clone = join(root, 'code', 'myrepo');
    await mkdir(join(root, 'code'));
    await run('git', ['clone', '-q', origin, clone], { env });
    await git(clone, 'commit', '-q', '--allow-empty', '-m', 'init');
    await git(clone, 'push', '-q', 'origin', 'main');
  });
  afterAll(() => rm(root, { recursive: true, force: true }));

  it('places worktrees next to the repo, slugging the branch', () => {
    expect(worktreePath('/Users/me/code/factorial', 'feat/mileage-v2')).toBe('/Users/me/code/factorial-worktrees/feat-mileage-v2');
  });

  it('finds the main repo root from the repo or any of its worktrees', async () => {
    expect(await repoRoot(clone)).toBe(clone);
    expect(await repoRoot(tmpdir())).toBeNull();
  });

  it('creates a worktree on a new branch off origin/main, without touching the main checkout', async () => {
    const dir = await createWorktree(clone, 'feat/x');
    expect(dir).toBe(join(root, 'code', 'myrepo-worktrees', 'feat-x'));
    expect((await stat(dir)).isDirectory()).toBe(true);
    expect((await git(dir, 'rev-parse', '--abbrev-ref', 'HEAD')).stdout.trim()).toBe('feat/x');
    expect((await git(clone, 'rev-parse', '--abbrev-ref', 'HEAD')).stdout.trim()).toBe('main');
    expect(await repoRoot(dir)).toBe(clone);
  });

  it('refuses an existing branch or directory, and a non-repo root, with a clear message', async () => {
    await expect(createWorktree(clone, 'feat/x')).rejects.toThrow(/branch feat\/x already exists/);
    await git(clone, 'branch', 'feat/y');
    await expect(createWorktree(clone, 'feat/y')).rejects.toThrow(/branch feat\/y already exists/);
    await mkdir(join(root, 'code', 'myrepo-worktrees', 'feat-z'), { recursive: true });
    await expect(createWorktree(clone, 'feat/z')).rejects.toThrow(/already exists: .*feat-z/);
    await expect(createWorktree(tmpdir(), 'feat/q')).rejects.toThrow(/not a git repository/);
  });
});
