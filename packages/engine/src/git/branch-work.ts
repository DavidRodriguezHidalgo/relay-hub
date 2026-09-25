import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** How many files are worth listing before a count says the rest. */
const FILES_MAX = 20;
/** Branches a repository is likely to have started from. */
const LIKELY_BASES = ['main', 'master', 'develop'];

export interface BranchWork {
  commits: { sha: string; subject: string; at: string }[];
  files: string[];
  moreFiles: number;
  base: string | null;
  note: string | null;
}

async function git(cwd: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await run('git', ['-C', cwd, ...args], { timeout: 10_000 });
    return stdout.trim();
  } catch {
    return null;
  }
}

/** The branch this one most likely grew from: the remote's default, else a usual name. */
async function baseOf(cwd: string, branch: string): Promise<string | null> {
  const head = await git(cwd, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
  const candidates = [head?.replace(/^origin\//, ''), ...LIKELY_BASES].filter(
    (b): b is string => typeof b === 'string' && b !== branch,
  );
  for (const candidate of candidates) {
    if (await git(cwd, ['rev-parse', '--verify', '--quiet', candidate])) return candidate;
  }
  return null;
}

/**
 * What a branch has added over the branch it grew from.
 *
 * Uncommitted files count as touched: they are part of what the session did, even though no
 * commit holds them yet. When there is no base to compare against — a repository with one
 * branch, or no repository at all — it says so rather than reporting an empty result as if
 * nothing had been done.
 */
export async function branchWork(cwd: string): Promise<BranchWork> {
  const empty: BranchWork = { commits: [], files: [], moreFiles: 0, base: null, note: null };
  const branch = await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (branch === null) return { ...empty, note: 'This directory is not a git repository.' };

  const base = await baseOf(cwd, branch);
  const uncommitted = (await git(cwd, ['status', '--porcelain']))
    ?.split('\n')
    .map((l) => l.slice(3).trim())
    .filter((f) => f.length > 0) ?? [];

  if (base === null) {
    const all = [...new Set(uncommitted)].sort();
    return { ...empty, files: all.slice(0, FILES_MAX), moreFiles: Math.max(0, all.length - FILES_MAX), note: 'No other branch to compare against.' };
  }

  const log = await git(cwd, ['log', '--format=%H%x00%s%x00%cI', `${base}..HEAD`]);
  const commits = (log ?? '')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => l.split('\0'))
    .filter((p) => p.length === 3)
    .map(([sha, subject, at]) => ({ sha: sha!, subject: subject!, at: at! }));

  const changed = (await git(cwd, ['diff', '--name-only', `${base}...HEAD`]))?.split('\n').filter((f) => f.trim().length > 0) ?? [];
  const files = [...new Set([...changed, ...uncommitted])].sort();

  return {
    commits,
    files: files.slice(0, FILES_MAX),
    moreFiles: Math.max(0, files.length - FILES_MAX),
    base,
    note: null,
  };
}
