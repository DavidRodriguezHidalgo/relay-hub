import { describe, expect, it } from 'vitest';
import { ExecGhClient } from '../../src/pr/gh-client';
import { diffSnapshots, toSnapshot } from '../../src/pr/snapshot';

const target = process.env.RELAY_LIVE_GH; // e.g. factorialco/factorial-agent#3299

describe.skipIf(!target)('gh client against GitHub', () => {
  it('reads a real PR, snapshots it and diffs it against itself without events', async () => {
    const [repo, num] = target!.split('#');
    const gh = new ExecGhClient();
    const viewer = await gh.viewer();
    const pr = await gh.viewPr(repo!, Number(num));
    expect(pr.number).toBe(Number(num));
    expect(pr.url).toContain(`/pull/${num}`);
    const snap = toSnapshot(pr);
    expect(diffSnapshots(snap, snap, pr, viewer)).toEqual([]);
    expect((await gh.listMyPrs()).every((p) => p.repo.includes('/'))).toBe(true);
  }, 60_000);
});
