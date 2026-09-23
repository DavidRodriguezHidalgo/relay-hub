import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ExecGitInfoProvider } from '../../src/git/git-info';

const run = promisify(execFile);

describe('ExecGitInfoProvider', () => {
  let root: string;
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'relay-git-'));
    const main = join(root, 'myrepo');
    await run('git', ['init', '-q', '-b', 'main', main]);
    await run('git', ['-C', main, 'commit', '-q', '--allow-empty', '-m', 'init'], {
      env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
    });
    await run('git', ['-C', main, 'worktree', 'add', '-q', '-b', 'feat/x', join(root, 'wt-x')]);
  });
  afterAll(() => rm(root, { recursive: true, force: true }));

  it('reports branch and main repo name for the main checkout', async () => {
    const info = await new ExecGitInfoProvider().inspect(join(root, 'myrepo'));
    expect(info).toEqual({ branch: 'main', repo: 'myrepo' });
  });

  it('groups a worktree under its main repo', async () => {
    const info = await new ExecGitInfoProvider().inspect(join(root, 'wt-x'));
    expect(info).toEqual({ branch: 'feat/x', repo: 'myrepo' });
  });

  it('returns nulls outside a repo instead of throwing', async () => {
    const info = await new ExecGitInfoProvider().inspect(tmpdir());
    expect(info).toEqual({ branch: null, repo: null });
  });
});
