import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** What git can be asked about a working directory; null fields mean it could not say. */
export interface WorkState {
  branch: string | null;
  lastCommit: { sha: string; subject: string; at: string } | null;
  uncommitted: number;
  unpushed: number;
  upstream: string | null;
}

async function git(cwd: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await run('git', ['-C', cwd, ...args], { timeout: 5_000 });
    return stdout.trim();
  } catch {
    return null;
  }
}

/** Reads the facts about a working directory: what is committed, what is not, what is unpushed. */
export async function workState(cwd: string): Promise<WorkState> {
  const branch = await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (branch === null) return { branch: null, lastCommit: null, uncommitted: 0, unpushed: 0, upstream: null };

  const [log, status, upstream] = await Promise.all([
    git(cwd, ['log', '-1', '--format=%H%x00%s%x00%cI']),
    git(cwd, ['status', '--porcelain']),
    git(cwd, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']),
  ]);

  const parts = log?.split('\0') ?? [];
  const lastCommit = parts.length === 3 ? { sha: parts[0]!, subject: parts[1]!, at: parts[2]! } : null;
  const uncommitted = status ? status.split('\n').filter((l) => l.trim().length > 0).length : 0;
  const ahead = upstream ? await git(cwd, ['rev-list', '--count', `${upstream}..HEAD`]) : null;

  return {
    branch,
    lastCommit,
    uncommitted,
    unpushed: Number.parseInt(ahead ?? '0', 10) || 0,
    upstream,
  };
}
