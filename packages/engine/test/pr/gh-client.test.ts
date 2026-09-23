import { describe, expect, it } from 'vitest';
import { ExecGhClient, repoFromPrUrl, type RunGh } from '../../src/pr/gh-client';

function fake(responses: Record<string, unknown>) {
  const calls: { args: string[]; cwd?: string }[] = [];
  const run: RunGh = async (args, opts) => {
    calls.push({ args, cwd: opts?.cwd });
    const key = args.slice(0, 2).join(' ');
    if (!(key in responses)) throw new Error(`gh ${args.join(' ')} failed`);
    return typeof responses[key] === 'string' ? (responses[key] as string) : JSON.stringify(responses[key]);
  };
  return { run, calls };
}

describe('ExecGhClient', () => {
  it('views a PR: checks keyed by workflow, feedback from REST with inline comments and bot flags', async () => {
    const { run, calls } = fake({
      'pr view': {
        number: 7, url: 'https://github.com/o/r/pull/7', title: 'Mileage', state: 'OPEN',
        headRefName: 'feat/m', headRefOid: 'abc', baseRefName: 'main', mergeable: 'MERGEABLE', mergeStateStatus: 'BLOCKED',
        statusCheckRollup: [
          { __typename: 'CheckRun', name: 'test', workflowName: 'CI', conclusion: 'FAILURE', status: 'COMPLETED' },
          { __typename: 'StatusContext', context: 'ci/legacy', state: 'ERROR' },
        ],
      },
      // the shapes gh api returns (one page each, --slurp wraps pages in an array)
      'api repos/o/r/pulls/7/reviews': [[
        { id: 1, user: { login: 'ana', type: 'User' }, body: '', state: 'APPROVED', submitted_at: '2026-09-23T10:00:00Z' },
        // an inline-only review: empty body, its substance is in the review comments below
        { id: 2, user: { login: 'carl', type: 'User' }, body: '', state: 'COMMENTED', submitted_at: '2026-09-23T10:01:00Z' },
      ]],
      'api repos/o/r/pulls/7/comments': [[
        { id: 20, user: { login: 'carl', type: 'User' }, body: '[P1] off by one', path: 'src/a.ts', line: 12, created_at: '2026-09-23T10:01:00Z' },
      ]],
      'api repos/o/r/issues/7/comments': [[
        { id: 30, user: { login: 'coderabbitai[bot]', type: 'Bot' }, body: 'Walkthrough', created_at: '2026-09-23T10:02:00Z' },
        { id: 31, user: { login: 'bob', type: 'User' }, body: 'nit', created_at: '2026-09-23T10:03:00Z' },
      ]],
    });
    const pr = await new ExecGhClient(run).viewPr('o/r', 7);
    expect(calls[0]!.args.slice(0, 5)).toEqual(['pr', 'view', '7', '--repo', 'o/r']);
    expect(calls.slice(1).map((c) => c.args.slice(0, 4))).toEqual([
      ['api', 'repos/o/r/pulls/7/reviews', '--paginate', '--slurp'],
      ['api', 'repos/o/r/pulls/7/comments', '--paginate', '--slurp'],
      ['api', 'repos/o/r/issues/7/comments', '--paginate', '--slurp'],
    ]);
    expect(pr.checks).toEqual([
      { name: 'CI / test', conclusion: 'FAILURE', status: 'COMPLETED' },
      { name: 'ci/legacy', conclusion: 'ERROR', status: 'COMPLETED' },
    ]);
    expect(pr.feedback).toEqual([
      { id: 'review-1', author: 'ana', body: 'APPROVED', at: '2026-09-23T10:00:00Z', bot: false },
      { id: 'inline-20', author: 'carl', body: 'src/a.ts:12: [P1] off by one', at: '2026-09-23T10:01:00Z', bot: false },
      { id: 'comment-30', author: 'coderabbitai[bot]', body: 'Walkthrough', at: '2026-09-23T10:02:00Z', bot: true },
      { id: 'comment-31', author: 'bob', body: 'nit', at: '2026-09-23T10:03:00Z', bot: false },
    ]);
  });

  it('finds the PR for a branch from the session cwd, or null', async () => {
    const { run, calls } = fake({ 'pr list': [{ number: 3, url: 'https://github.com/o/r/pull/3' }] });
    expect(await new ExecGhClient(run).findPrForBranch('/repo', 'feat/x')).toEqual({ repo: 'o/r', number: 3, url: 'https://github.com/o/r/pull/3' });
    expect(calls[0]).toMatchObject({ cwd: '/repo', args: ['pr', 'list', '--head', 'feat/x', '--state', 'open', '--json', 'number,url', '--limit', '1'] });
    const none = fake({ 'pr list': [] });
    expect(await new ExecGhClient(none.run).findPrForBranch('/repo', 'feat/x')).toBeNull();
  });

  it('reads the viewer login and lists my open PRs', async () => {
    const { run } = fake({
      'api user': 'davidr\n',
      // search finds the repos; pr list per repo gives the branch (search has no headRefName)
      'search prs': [{ number: 1, url: 'https://github.com/o/r/pull/1', repository: { nameWithOwner: 'o/r' } }],
      'pr list': [{ number: 1, url: 'https://github.com/o/r/pull/1', title: 'A', headRefName: 'a', state: 'OPEN' }],
    });
    const gh = new ExecGhClient(run);
    expect(await gh.viewer()).toBe('davidr');
    expect(await gh.listMyPrs()).toEqual([{ repo: 'o/r', number: 1, url: 'https://github.com/o/r/pull/1', title: 'A', headRefName: 'a', state: 'OPEN' }]);
  });

  it('propagates gh failures', async () => {
    await expect(new ExecGhClient(fake({}).run).viewPr('o/r', 1)).rejects.toThrow(/gh pr view/);
  });
});

describe('repoFromPrUrl', () => {
  it('extracts owner/name', () => {
    expect(repoFromPrUrl('https://github.com/factorialco/factorial/pull/115760')).toBe('factorialco/factorial');
    expect(repoFromPrUrl('not a url')).toBeNull();
  });
});
