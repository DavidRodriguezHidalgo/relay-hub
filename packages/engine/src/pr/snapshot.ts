import type { PrEvent } from '@relay/shared';
import type { PrData } from './gh-client';

/** Bots GitHub does not always type as one (e.g. in `gh pr view` data); ignored as review feedback. */
export const BOT_LOGINS: readonly string[] = [
  'github-actions',
  'dependabot',
  'codecov',
  'renovate',
  'vercel',
  'netlify',
  'sonarcloud',
  'linear',
];
/** A cancelled job is superseded or stopped, not a failure to fix. */
const FAILING = new Set(['FAILURE', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'ERROR']);
const BODY_MAX = 800;

/** What one poll of a PR is compared on. */
export interface PrSnapshot {
  state: PrData['state'];
  headRefOid: string;
  baseRefName: string;
  mergeable: PrData['mergeable'];
  mergeStateStatus: string;
  /** Names of failing checks on `headRefOid`, sorted. */
  failingChecks: string[];
  /** ISO time of the newest feedback seen ('' if none). */
  lastFeedbackAt: string;
}

const clip = (t: string) => (t.length > BODY_MAX ? `${t.slice(0, BODY_MAX)}…` : t);
const isBot = (f: PrData['feedback'][number]) =>
  f.bot || f.author.endsWith('[bot]') || BOT_LOGINS.includes(f.author.toLowerCase());
const blocked = (s: PrSnapshot) => s.mergeable === 'CONFLICTING' || s.mergeStateStatus === 'BEHIND';

/**
 * GitHub recomputes mergeability lazily and reports UNKNOWN meanwhile; keep the last known value
 * so CONFLICTING → UNKNOWN → CONFLICTING is not a new conflict.
 */
export function carryForward(prev: PrSnapshot, next: PrSnapshot): PrSnapshot {
  return {
    ...next,
    mergeable: next.mergeable === 'UNKNOWN' ? prev.mergeable : next.mergeable,
    mergeStateStatus: next.mergeStateStatus === 'UNKNOWN' ? prev.mergeStateStatus : next.mergeStateStatus,
  };
}

export function toSnapshot(pr: PrData): PrSnapshot {
  return {
    state: pr.state,
    headRefOid: pr.headRefOid,
    baseRefName: pr.baseRefName,
    mergeable: pr.mergeable,
    mergeStateStatus: pr.mergeStateStatus,
    failingChecks: pr.checks
      .filter((c) => c.conclusion !== null && FAILING.has(c.conclusion))
      .map((c) => c.name)
      .sort(),
    lastFeedbackAt: pr.feedback.reduce((max, f) => (f.at > max ? f.at : max), ''),
  };
}

/** Events between two polls of one PR; `pr` is the newer data, used for the wake messages. */
export function diffSnapshots(prev: PrSnapshot, next: PrSnapshot, pr: PrData, viewer: string): PrEvent[] {
  const ref = `PR #${pr.number} (${pr.url})`;
  if (next.state === 'MERGED' && prev.state !== 'MERGED') {
    return [{ kind: 'merged', summary: `PR #${pr.number} merged`, details: `${ref} was merged.` }];
  }
  const events: PrEvent[] = [];

  // a new head commit starts from a clean slate: its failures are all new
  const before = prev.headRefOid === next.headRefOid ? new Set(prev.failingChecks) : new Set<string>();
  const newlyFailing = next.failingChecks.filter((n) => !before.has(n));
  // CLEAN means GitHub already considers the PR mergeable: whatever failed is not required
  if (newlyFailing.length > 0 && next.mergeStateStatus !== 'CLEAN') {
    events.push({
      kind: 'ci_failed',
      summary: `CI failed on PR #${pr.number}: ${newlyFailing.join(', ')}`,
      details:
        `CI failed on ${ref}. Newly failing checks: ${newlyFailing.join(', ')}. ` +
        `Look at the failures (for example \`gh pr checks ${pr.number}\` and \`gh run view --log-failed\`), ` +
        'fix them, run the tests, and push.',
    });
  }

  const fresh = pr.feedback.filter((f) => f.at > prev.lastFeedbackAt && f.author !== viewer && !isBot(f));
  if (fresh.length > 0) {
    const lines = fresh.map((f) => `- ${f.author}: ${clip(f.body)}`).join('\n');
    events.push({
      kind: 'review_comment',
      summary: `New feedback on PR #${pr.number} from ${[...new Set(fresh.map((f) => f.author))].join(', ')}`,
      details:
        `New review feedback on ${ref}:\n${lines}\n` +
        'Address it in the code, run the tests, and push. Reply on the PR only if a change is not warranted.',
    });
  }

  if (blocked(next) && !blocked(prev)) {
    const why = next.mergeable === 'CONFLICTING' ? 'now has conflicts with' : 'is now behind';
    events.push({
      kind: 'base_moved',
      summary: `PR #${pr.number} ${why} ${pr.baseRefName}`,
      details:
        `${ref} ${why} its base branch ${pr.baseRefName}. ` +
        `Fetch, rebase onto origin/${pr.baseRefName}, resolve any conflicts, run the tests, and push.`,
    });
  }
  return events;
}
