import { describe, expect, it } from 'vitest';
import type { CheckoutPlan } from '@relay/shared';
import { checkoutStanding } from './checkoutStanding';

const plan = (over: Partial<CheckoutPlan>): CheckoutPlan => ({
  kind: 'up-to-date', reason: null, branch: 'main', upstream: 'origin/main',
  commits: [], needsInstall: false, runningSha: 'aaaaaaa1111', headSha: 'aaaaaaa1111', ...over,
});

describe('checkoutStanding', () => {
  it('says to pull when commits are waiting, and how many', () => {
    const s = checkoutStanding(plan({ commits: [{ sha: 'a', subject: 'one' }, { sha: 'b', subject: 'two' }] }));
    expect(s).toMatchObject({ kind: 'behind' });
    expect(s?.message).toBe('2 commits waiting on main. Pull to get them.');
  });

  it('counts a single waiting commit in the singular', () => {
    expect(checkoutStanding(plan({ commits: [{ sha: 'a', subject: 'one' }] }))?.message).toBe(
      '1 commit waiting on main. Pull to get it.',
    );
  });

  it('says to restart when the checkout moved under a running app', () => {
    const s = checkoutStanding(plan({ runningSha: 'old1234abcd', headSha: 'new5678efgh' }));
    expect(s).toMatchObject({ kind: 'restart' });
    expect(s?.message).toContain('still running old1234');
    expect(s?.message).toContain('restart it to run new5678');
  });

  it('pulling comes before restarting: there is no point restarting onto a stale checkout', () => {
    const s = checkoutStanding(plan({ commits: [{ sha: 'a', subject: 'one' }], runningSha: 'old', headSha: 'new' }));
    expect(s?.kind).toBe('behind');
  });

  it('says so plainly when nothing is missing, which leaves only an unmerged change', () => {
    const s = checkoutStanding(plan({}));
    expect(s).toMatchObject({ kind: 'current' });
    expect(s?.message).toContain('Up to date: running aaaaaaa on main');
    expect(s?.message).toContain('has not been merged yet');
  });

  it('does not guess when the commits cannot be read', () => {
    const s = checkoutStanding(plan({ runningSha: null, headSha: null }));
    expect(s?.kind).toBe('current');
    expect(s?.message).toContain('an unknown commit');
  });

  it('has nothing to say before the checkout has been inspected', () => {
    expect(checkoutStanding(null)).toBeNull();
  });
});
