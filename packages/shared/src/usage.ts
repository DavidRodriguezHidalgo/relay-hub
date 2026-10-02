/**
 * How much of the account's allowance is gone, and when it comes back.
 *
 * This is the account, not a session: every session on the machine draws on the same windows, so
 * it belongs beside the app rather than inside one conversation.
 */
export interface UsageWindow {
  /** `five-hour` is the rolling session window; `seven-day` is the weekly one. */
  kind: 'five-hour' | 'seven-day';
  /** Whole percent of the window used, as the source reports it. */
  percent: number;
  /** When the window rolls over, ISO. */
  resetsAt: string;
}

/**
 * What Relay knows about the account's limits.
 *
 * `available: false` is a real answer and is shown as one. The number comes from an API the SDK
 * marks as experimental, so it can disappear under a Claude Code upgrade; when it does, Relay says
 * it does not know rather than showing a stale figure.
 */
export interface AccountUsage {
  available: boolean;
  /** The plan name the source reports, e.g. `team`; null when it does not say. */
  plan: string | null;
  windows: UsageWindow[];
  /** When Relay last got an answer, ISO; null when it never has. */
  checkedAt: string | null;
}

/** Quiet below this; it is not worth a glance when there is plenty left. */
export const USAGE_NOTABLE = 60;
/** Worth noticing: enough gone that how you spread the next few hours matters. */
export const USAGE_TIGHT = 80;
/** Close enough to the end that a long task may not finish. */
export const USAGE_CRITICAL = 92;

export type UsageLevel = 'calm' | 'notable' | 'tight' | 'critical';

export function usageLevel(percent: number): UsageLevel {
  if (percent >= USAGE_CRITICAL) return 'critical';
  if (percent >= USAGE_TIGHT) return 'tight';
  if (percent >= USAGE_NOTABLE) return 'notable';
  return 'calm';
}

/**
 * The window that decides what you can do next: whichever is furthest through.
 *
 * Both windows have to clear for work to continue, so the fuller one is the one that will stop
 * you, whichever it happens to be.
 */
export function pressingWindow(usage: AccountUsage | null): UsageWindow | null {
  if (!usage?.available || usage.windows.length === 0) return null;
  return usage.windows.reduce((worst, w) => (w.percent > worst.percent ? w : worst));
}

const WINDOW_NAME: Record<UsageWindow['kind'], string> = {
  'five-hour': 'Current session',
  'seven-day': 'This week',
};

/** When a window rolls over, said the way a person would: a time today, a weekday beyond that. */
export function resetWording(resetsAt: string, now: Date): string {
  const at = new Date(resetsAt);
  if (Number.isNaN(at.getTime())) return 'at an unknown time';
  const time = at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const sameDay = at.toDateString() === now.toDateString();
  return sameDay ? `at ${time}` : `${at.toLocaleDateString([], { weekday: 'short' })} ${time}`;
}

/** Every window spelled out, for the tooltip; the strip itself only has room for the worst. */
export function usageSentence(usage: AccountUsage | null, now: Date): string {
  if (!usage) return 'Checking how much of your usage limit is left…';
  if (!usage.available) {
    return 'Relay cannot read your usage limits from Claude Code, so it is not showing a number it cannot stand behind.';
  }
  const lines = usage.windows.map((w) => `${WINDOW_NAME[w.kind]}: ${w.percent}% used, resets ${resetWording(w.resetsAt, now)}.`);
  return lines.join(' ');
}
