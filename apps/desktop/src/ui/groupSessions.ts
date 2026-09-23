import type { SessionSummary } from '@relay/shared';

export interface SessionGroup {
  repo: string;
  sessions: SessionSummary[];
}

/** Filters and groups sessions for the sidebar; groups and rows are newest-first. */
export function groupSessions(
  sessions: SessionSummary[],
  opts: { query: string; showStale: boolean },
): SessionGroup[] {
  const q = opts.query.trim().toLowerCase();
  const visible = sessions.filter(
    (s) =>
      (opts.showStale || !s.isStale) &&
      (q === '' || [s.title, s.branch ?? '', s.repo].some((f) => f.toLowerCase().includes(q))),
  );
  const byRepo = new Map<string, SessionSummary[]>();
  for (const s of visible) byRepo.set(s.repo, [...(byRepo.get(s.repo) ?? []), s]);
  const newest = (list: SessionSummary[]) => list[0]?.lastActivity ?? '';
  return [...byRepo.entries()]
    .map(([repo, list]) => ({
      repo,
      sessions: list.sort((a, b) => b.lastActivity.localeCompare(a.lastActivity)),
    }))
    .sort((a, b) => newest(b.sessions).localeCompare(newest(a.sessions)));
}
