import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chmod, mkdir, mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises';
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

  it('a branch that exists only on origin gets a worktree tracking it, keeping its commits', async () => {
    const other = join(root, 'other');
    await run('git', ['clone', '-q', join(root, 'origin.git'), other], { env });
    await git(other, 'checkout', '-q', '-b', 'feat/remote');
    await git(other, 'commit', '-q', '--allow-empty', '-m', 'remote work');
    await git(other, 'push', '-q', 'origin', 'feat/remote');
    const pushed = (await git(other, 'rev-parse', 'HEAD')).stdout.trim();
    const dir = await createWorktree(clone, 'feat/remote');
    expect((await git(dir, 'rev-parse', 'HEAD')).stdout.trim()).toBe(pushed);
    expect((await git(dir, 'rev-parse', '--abbrev-ref', '@{upstream}')).stdout.trim()).toBe('origin/feat/remote');
  });

  it("a checkout that fails half-way leaves no branch or worktree behind, so a retry can work", async () => {
    const hook = join(clone, ".git", "hooks", "post-checkout");
    await writeFile(hook, "#!/bin/sh\nexit 1\n");
    await chmod(hook, 0o755);
    await expect(createWorktree(clone, "feat/hooked")).rejects.toThrow();
    await rm(hook);
    expect((await git(clone, "branch", "--list", "feat/hooked")).stdout.trim()).toBe("");
    expect((await git(clone, "worktree", "list")).stdout).not.toContain("feat-hooked");
    expect(await createWorktree(clone, "feat/hooked")).toBe(join(root, "code", "myrepo-worktrees", "feat-hooked"));
  });

  it("a repo without origin branches off its own current branch", async () => {
    const local = join(root, "code", "localonly");
    await run("git", ["init", "-q", "-b", "master", local]);
    await git(local, "commit", "-q", "--allow-empty", "-m", "init");
    const dir = await createWorktree(local, "feat/l");
    expect((await git(dir, "rev-parse", "HEAD")).stdout.trim()).toBe((await git(local, "rev-parse", "master")).stdout.trim());
  });

  it("an origin whose default is master, without a recorded origin/HEAD, still works", async () => {
    const originM = join(root, "originm.git");
    await run("git", ["init", "-q", "--bare", "-b", "master", originM]);
    const repo = join(root, "code", "masterrepo");
    await run("git", ["init", "-q", "-b", "master", repo]);
    await git(repo, "commit", "-q", "--allow-empty", "-m", "init");
    await git(repo, "remote", "add", "origin", originM);
    await git(repo, "push", "-q", "origin", "master");
    const dir = await createWorktree(repo, "feat/m");
    expect((await git(dir, "rev-parse", "--abbrev-ref", "HEAD")).stdout.trim()).toBe("feat/m");
  });

  it("a submodule's root is its own working tree, and a bare repo has none", async () => {
    const sup = join(root, "code", "super");
    await run("git", ["init", "-q", "-b", "main", sup]);
    await git(sup, "commit", "-q", "--allow-empty", "-m", "init");
    await run("git", ["-C", sup, "-c", "protocol.file.allow=always", "submodule", "add", "-q", join(root, "origin.git"), "mod"], { env });
    expect(await repoRoot(join(sup, "mod"))).toBe(join(sup, "mod"));
    expect(await repoRoot(join(root, "origin.git"))).toBeNull();
  });
});
