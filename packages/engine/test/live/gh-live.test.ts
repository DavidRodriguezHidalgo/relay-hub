import { describe, expect, it } from 'vitest';
import { ExecGhClient } from '../../src/pr/gh-client';
import { diffSnapshots, toSnapshot, type PrSnapshot } from '../../src/pr/snapshot';

/**
 * Read-only checks against real PRs (no tokens, just `gh`). Opt in with
 * `RELAY_LIVE_GH=owner/repo#1,owner/repo#2` — ideally PRs with reviews, inline comments,
 * bot comments and failing or cancelled jobs, since those are the shapes that matter.
 */
const targets = (process.env.RELAY_LIVE_GH ?? '').split(',').filter(Boolean);

const empty: PrSnapshot = {
  state: 'OPEN', headRefOid: '', baseRefName: '', mergeable: 'MERGEABLE', mergeStateStatus: 'BLOCKED',
  failingChecks: [], lastFeedbackAt: '',
};

describe.skipIf(targets.length === 0)('gh client against GitHub', () => {
  it('reads real PRs and, diffed from an empty baseline, never names bots or wakes a mergeable PR for CI', async () => {
    const gh = new ExecGhClient();
    const viewer = await gh.viewer();
    for (const target of targets) {
      const [repo, num] = target.split('#');
      const pr = await gh.viewPr(repo!, Number(num));
      expect(pr.url).toContain(`/pull/${num}`);
      const snap = toSnapshot(pr);
      expect(diffSnapshots(snap, snap, pr, viewer)).toEqual([]);
      const events = diffSnapshots({ ...empty, state: pr.state === 'MERGED' ? 'MERGED' : 'OPEN' }, snap, pr, viewer);
      const review = events.find((e) => e.kind === 'review_comment');
      for (const f of pr.feedback.filter((x) => x.bot)) expect(review?.summary ?? '').not.toContain(f.author);
      if (pr.mergeStateStatus === 'CLEAN') expect(events.map((e) => e.kind)).not.toContain('ci_failed');
      // inline review comments are part of the feedback
      const inline = pr.feedback.filter((f) => f.id.startsWith('inline-'));
      console.log(`${target}: ${pr.state}/${pr.mergeStateStatus}, ${pr.checks.length} checks, ${pr.feedback.length} feedback (${inline.length} inline, ${pr.feedback.filter((x) => x.bot).length} bot) → ${events.map((e) => e.kind).join(',') || 'no events'}`);
    }
    expect((await gh.listMyPrs()).every((p) => p.repo.includes('/'))).toBe(true);
  }, 120_000);
});
