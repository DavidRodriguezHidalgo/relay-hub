import type { ExternalSessions, RunState, SessionSummary } from '@relay/shared';

/** Another session that could still write where this one is working. */
export interface Collision {
  kind: 'directory' | 'branch';
  cwd: string;
  branch: string | null;
  others: SessionSummary[];
  /** Identifies this exact clash, so dismissing it lasts only while it stays the same. */
  key: string;
}

export interface Liveness {
  states: RunState['states'];
  external: ExternalSessions;
  now: number;
}

/** A session finished hours ago is no hazard; one still in play is. */
const RECENT_MS = 2 * 60 * 60 * 1000;

function inPlay(s: SessionSummary, live: Liveness): boolean {
  if (s.isStale || !s.cwdExists || s.continuedIn !== null) return false;
  const state = live.states[s.id]?.state;
  if (state === 'running' || state === 'waiting-approval') return true;
  if (live.external[s.id]) return true;
  return live.now - new Date(s.lastActivity).getTime() < RECENT_MS;
}

/**
 * Whether another session that could still write is working where this one is.
 *
 * Only sessions in play count: one Relay is driving, one open in another Claude, or one active
 * in the last couple of hours. Every session ever started in a directory shares its path, and
 * warning about those buries the one that matters.
 *
 * Sharing a directory is what loses work, since both edit the same files. Sharing a branch of one
 * repository from different directories is milder, and meets at push time instead.
 */
export function collisionFor(sessions: SessionSummary[], id: string, live: Liveness): Collision | null {
  const self = sessions.find((s) => s.id === id);
  if (!self || !inPlay(self, live)) return null;
  const others = sessions.filter((s) => s.id !== id && inPlay(s, live));

  const make = (kind: Collision['kind'], hits: SessionSummary[]): Collision => ({
    kind,
    cwd: self.cwd,
    branch: self.branch,
    others: hits,
    key: `${kind}:${self.cwd}:${self.branch ?? ''}:${hits.map((h) => h.id).sort().join(',')}`,
  });

  const sameDir = others.filter((s) => s.cwd === self.cwd);
  if (sameDir.length > 0) return make('directory', sameDir);
  const sameBranch = self.branch ? others.filter((s) => s.branch === self.branch && s.repo === self.repo) : [];
  return sameBranch.length > 0 ? make('branch', sameBranch) : null;
}
