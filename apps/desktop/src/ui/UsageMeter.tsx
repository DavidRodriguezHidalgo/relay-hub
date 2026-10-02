import { pressingWindow, resetWording, usageLevel, usageSentence, type AccountUsage } from '@relay/shared';

interface Props {
  /** null before the first answer has arrived. */
  usage: AccountUsage | null;
  now: Date;
  /** Opens the detail, which is where there is room to explain the number. */
  onOpen: () => void;
}

/**
 * How close the account is to its limit, in the title strip.
 *
 * Silent while there is plenty left: a number you do not need is just noise in the one piece of
 * chrome that is always on screen. It appears once enough is gone to change how you would spread
 * the next few hours, and gets more insistent from there.
 *
 * It says the percentage and when the allowance returns, and nothing else — the window that is
 * worst, what the other one is at, and where the figure comes from are all a click away in
 * Settings, which is the only place with room to say them honestly.
 */
export function UsageMeter({ usage, now, onOpen }: Props) {
  const worst = pressingWindow(usage);
  if (!worst) return null;
  const level = usageLevel(worst.percent);
  if (level === 'calm') return null;
  // the reset time is the actionable half, but only once it is close enough to plan around
  const showReset = level === 'tight' || level === 'critical';
  return (
    <button
      type="button"
      className={`usage-pill usage-pill--${level}`}
      title={usageSentence(usage, now)}
      onClick={onOpen}
    >
      {worst.percent}% used{showReset ? ` · back ${resetWording(worst.resetsAt, now)}` : ''}
    </button>
  );
}
