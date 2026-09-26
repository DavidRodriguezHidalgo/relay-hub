import type { CheckoutPlan } from '@relay/shared';

/** Why what you are looking at is not what you expected, and what to do about it. */
export interface Standing {
  kind: 'behind' | 'restart' | 'current';
  message: string;
}

const short = (sha: string | null | undefined) => (sha ? sha.slice(0, 7) : 'an unknown commit');

/**
 * Tells apart the three reasons a change you are looking for is not on screen.
 *
 * They used to be indistinguishable: pulling, rebuilding and waiting on a pull request all
 * ended with the same puzzled look at the same window. Each now says which one it is, and the
 * last says so positively — if the checkout is current and the process matches it, then what is
 * missing was never merged, and no amount of pulling or restarting will bring it.
 */
export function checkoutStanding(plan: CheckoutPlan | null): Standing | null {
  if (!plan) return null;
  if (plan.commits.length > 0) {
    const n = plan.commits.length;
    return {
      kind: 'behind',
      message: `${n} commit${n === 1 ? '' : 's'} waiting on ${plan.branch ?? 'your branch'}. Pull to get ${n === 1 ? 'it' : 'them'}.`,
    };
  }
  if (plan.runningSha && plan.headSha && plan.runningSha !== plan.headSha) {
    return {
      kind: 'restart',
      message: `You have pulled since this app started. It is still running ${short(plan.runningSha)}; restart it to run ${short(plan.headSha)}.`,
    };
  }
  return {
    kind: 'current',
    message: `Up to date: running ${short(plan.headSha ?? plan.runningSha)} on ${plan.branch ?? 'your branch'}. Anything missing has not been merged yet.`,
  };
}
