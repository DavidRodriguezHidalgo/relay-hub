import { execFile } from 'node:child_process';
import { access, realpath } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await run('git', ['-C', cwd, ...args], { timeout: 120_000 });
    return stdout.trim();
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr?.trim();
    throw new Error(`git ${args[0]} failed${stderr ? `: ${stderr}` : ''}`);
  }
}

const exists = (p: string) => access(p).then(() => true, () => false);

/** `~/code/factorial` + `feat/x` → `~/code/factorial-worktrees/feat-x`. */
export function worktreePath(root: string, branch: string): string {
  return join(dirname(root), `${basename(root)}-worktrees`, branch.replaceAll('/', '-'));
}

/** The main repository root (symlinks resolved) for a repo or any of its worktrees; null outside git. */
export async function repoRoot(cwd: string): Promise<string | null> {
  try {
    const common = await git(cwd, ['rev-parse', '--git-common-dir']);
    return await realpath(dirname(resolve(cwd, common)));
  } catch {
    return null;
  }
}

async function defaultBranch(root: string): Promise<string> {
  try {
    return (await git(root, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])).replace(/^origin\//, '');
  } catch {
    return 'main';
  }
}

/**
 * A worktree for `branch`: tracking it when it already exists on origin (e.g. a PR branch), else a
 * new branch off the freshly fetched default branch. The main checkout is never touched.
 */
export async function createWorktree(root: string, branch: string): Promise<string> {
  if ((await repoRoot(root)) === null) throw new Error(`${root} is not a git repository`);
  try {
    await git(root, ['check-ref-format', '--branch', branch]);
  } catch {
    throw new Error(`"${branch}" is not a valid branch name`);
  }
  const known = await git(root, ['branch', '--list', '--', branch]);
  if (known !== '') throw new Error(`The branch ${branch} already exists; pick another name or use its worktree`);
  const dir = worktreePath(root, branch);
  if (await exists(dir)) throw new Error(`Worktree directory already exists: ${dir}`);
  const onOrigin = await git(root, ['ls-remote', '--heads', 'origin', `refs/heads/${branch}`]);
  if (onOrigin !== '') {
    await git(root, ['fetch', '-q', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`]);
    await git(root, ['worktree', 'add', '-q', '--track', '-b', branch, dir, `origin/${branch}`]);
    return dir;
  }
  const base = await defaultBranch(root);
  await git(root, ['fetch', '-q', 'origin', base]);
  await git(root, ['worktree', 'add', '-q', '-b', branch, dir, `origin/${base}`]);
  return dir;
}
