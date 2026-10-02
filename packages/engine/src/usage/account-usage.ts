import type { AccountUsage, UsageWindow } from '@relay/shared';

/**
 * The buckets Relay reports, and what each is called here.
 *
 * The source also returns a long list of further buckets — per-model weekly ones and several under
 * codenames — which were all null on the accounts this was built against. They are left out rather
 * than guessed at: a bar labelled with the wrong model is worse than no bar.
 */
const WINDOWS: { key: string; kind: UsageWindow['kind'] }[] = [
  { key: 'five_hour', kind: 'five-hour' },
  { key: 'seven_day', kind: 'seven-day' },
];

const nothing = (checkedAt: string): AccountUsage => ({ available: false, plan: null, windows: [], checkedAt });

function windowFrom(raw: unknown, kind: UsageWindow['kind']): UsageWindow | null {
  if (!raw || typeof raw !== 'object') return null;
  const { utilization, resets_at: resetsAt } = raw as { utilization?: unknown; resets_at?: unknown };
  // half an answer is not an answer: a percentage with no reset cannot say when it frees up
  if (typeof utilization !== 'number' || typeof resetsAt !== 'string') return null;
  return { kind, percent: Math.round(utilization), resetsAt };
}

/**
 * Reads the usage payload into something Relay can show, or into an honest "not known".
 *
 * Written to tolerate the shape changing underneath it. The method it comes from is marked
 * experimental by the SDK itself, so anything unrecognised means Relay says it cannot tell rather
 * than reporting a number it has stopped understanding.
 */
export function accountUsageFrom(raw: unknown, checkedAt: string): AccountUsage {
  if (!raw || typeof raw !== 'object') return nothing(checkedAt);
  const { rate_limits_available: ok, rate_limits: limits, subscription_type: plan } = raw as Record<string, unknown>;
  if (ok !== true || !limits || typeof limits !== 'object') return nothing(checkedAt);
  const windows = WINDOWS.map(({ key, kind }) => windowFrom((limits as Record<string, unknown>)[key], kind)).filter(
    (w): w is UsageWindow => w !== null,
  );
  if (windows.length === 0) return nothing(checkedAt);
  return { available: true, plan: typeof plan === 'string' ? plan : null, windows, checkedAt };
}
