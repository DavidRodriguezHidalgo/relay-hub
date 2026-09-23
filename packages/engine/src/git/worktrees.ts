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

/**
 * The main repository root (symlinks resolved) for a repo or any of its worktrees; null outside git
 * and for a bare repo, which has no working tree to run a session in.
 */
export async function repoRoot(cwd: string): Promise<string | null> {
  try {
    const common = resolve(cwd, await git(cwd, ['rev-parse', '--git-common-dir']));
    // a normal repo keeps its data in <root>/.git; a submodule in the superproject's .git/modules/<name>
    if (basename(common) === '.git') return await realpath(dirname(common));
    if ((await git(cwd, ['rev-parse', '--is-bare-repository'])) === 'true') return null;
    return await realpath(await git(cwd, ['rev-parse', '--show-toplevel']));
  } catch {
    return null;
  }
}

const hasOrigin = (root: string) => git(root, ['remote', 'get-url', 'origin']).then(() => true, () => false);

/** origin's default branch: the recorded origin/HEAD, else what origin itself says, else main. */
async function defaultBranch(root: string): Promise<string> {
  try {
    return (await git(root, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])).replace(/^origin\//, '');
  } catch {
    const head = await git(root, ['ls-remote', '--symref', 'origin', 'HEAD']).catch(() => '');
    const ref = head.split('\n').find((l) => l.startsWith('ref: refs/heads/'));
    return ref ? ref.slice('ref: refs/heads/'.length).split('\t')[0]! : 'main';
  }
}

/** Adds the worktree; if git fails half-way (a hook, a timeout), removes what it left so a retry can work. */
async function addWorktree(root: string, dir: string, args: string[], branch: string): Promise<void> {
  try {
    await git(root, ['worktree', 'add', '-q', ...args]);
  } catch (err) {
    await git(root, ['worktree', 'remove', '--force', dir]).catch(() => undefined);
    await git(root, ['worktree', 'prune']).catch(() => undefined);
    // the branch was created by this call, from a remote or base commit: nothing of the user's is on it
    await git(root, ['branch', '-D', '--', branch]).catch(() => undefined);
    throw err;
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
  if (!(await hasOrigin(root))) {
    // no remote: branch off whatever the main checkout is on, without touching it
    const current = await git(root, ['symbolic-ref', '--short', 'HEAD']);
    await addWorktree(root, dir, ['-b', branch, dir, current], branch);
    return dir;
  }
  const onOrigin = await git(root, ['ls-remote', '--heads', 'origin', `refs/heads/${branch}`]);
  if (onOrigin !== '') {
    await git(root, ['fetch', '-q', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`]);
    await addWorktree(root, dir, ['--track', '-b', branch, dir, `origin/${branch}`], branch);
    return dir;
  }
  const base = await defaultBranch(root);
  await git(root, ['fetch', '-q', 'origin', `+refs/heads/${base}:refs/remotes/origin/${base}`]);
  await addWorktree(root, dir, ['-b', branch, dir, `origin/${base}`], branch);
  return dir;
}
