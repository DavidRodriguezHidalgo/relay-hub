import type { ExternalSessions, RunState, SessionSummary } from '@relay/shared';
import { dotState, isActive } from './sessionDot';

/**
 * How far back the list reaches before you ask for more.
 *
 * Two days rather than one: a morning should still show yesterday afternoon's work, which a
 * 24-hour window drops exactly when you come back to it.
 */
export const RECENT_WINDOW_MS = 48 * 60 * 60 * 1000;

/**
 * The list never falls below this many rows on age alone.
 *
 * Coming back after a week away, every session is old; hiding all of them would leave an empty
 * panel and a "show all" button, which is a worse answer than simply showing the last few.
 */
export const MIN_SHOWN = 5;

export interface RecencyOptions {
  now: number;
  states?: RunState['states'];
  external?: ExternalSessions;
  /** Kept whatever its age, so the session being read cannot disappear from under you. */
  selectedId?: string | null;
  /** A search looks through everything; recency only shapes the list at rest. */
  searching: boolean;
  showAll: boolean;
}

export interface RecentSplit {
  shown: SessionSummary[];
  /** How many the window is holding back, for saying so out loud. */
  hidden: number;
}

/**
 * Narrows the list to what is in play, keeping the order it was given.
 *
 * Age alone is not enough: a session that is working, waiting for an approval, or running in
 * another process stays on the list however old it is, because those are the ones that cannot
 * afford to be missed.
 */
export function recentSessions(sessions: SessionSummary[], opts: RecencyOptions): RecentSplit {
  if (opts.showAll || opts.searching) return { shown: sessions, hidden: 0 };
  const cutoff = opts.now - RECENT_WINDOW_MS;
  const keep = new Set(
    sessions
      .filter(
        (s) =>
          s.id === opts.selectedId ||
          isActive(dotState(s.id, opts.states, opts.external)) ||
          Date.parse(s.lastActivity) >= cutoff,
      )
      .map((s) => s.id),
  );
  // rather than leave the panel empty, top up with the newest of what age would have hidden
  if (keep.size < MIN_SHOWN) {
    const newestFirst = sessions
      .filter((s) => !keep.has(s.id))
      .sort((a, b) => b.lastActivity.localeCompare(a.lastActivity));
    for (const s of newestFirst.slice(0, MIN_SHOWN - keep.size)) keep.add(s.id);
  }
  const shown = sessions.filter((s) => keep.has(s.id));
  return { shown, hidden: sessions.length - shown.length };
}
