import { execFile } from 'node:child_process';
import { basename, dirname, resolve } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

export interface GitInfo {
  branch: string | null;
  /** Directory name of the main repository; shared by all its worktrees. */
  repo: string | null;
}

export interface GitInfoProvider {
  inspect(cwd: string): Promise<GitInfo>;
}

async function git(cwd: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await run('git', ['-C', cwd, ...args], { timeout: 5_000 });
    return stdout.trim();
  } catch {
    return null;
  }
}

/** Reads branch and repo identity by invoking the `git` binary. */
export class ExecGitInfoProvider implements GitInfoProvider {
  async inspect(cwd: string): Promise<GitInfo> {
    const [branch, commonDir] = await Promise.all([
      git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']),
      git(cwd, ['rev-parse', '--git-common-dir']),
    ]);
    if (commonDir === null) return { branch: null, repo: null };
    const repo = basename(dirname(resolve(cwd, commonDir)));
    return { branch, repo };
  }
}
