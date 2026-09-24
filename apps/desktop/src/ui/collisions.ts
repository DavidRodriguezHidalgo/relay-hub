import type { SessionSummary } from '@relay/shared';

/** Another session working in the same place, and what it shares with this one. */
export interface Collision {
  kind: 'directory' | 'branch';
  cwd: string;
  branch: string | null;
  others: SessionSummary[];
}

/** A session that could still be driven, so its edits would land alongside another's. */
const live = (s: SessionSummary) => !s.isStale && s.cwdExists && s.continuedIn === null;

/**
 * Whether another live session is working where this one is.
 *
 * Sharing a directory is the one that loses work: two sessions edit the same files and neither
 * knows. Sharing a branch of one repository from different directories is milder but still ends
 * in a conflict at push time. A branch name alone is not enough, since repositories repeat them.
 */
export function collisionFor(sessions: SessionSummary[], id: string): Collision | null {
  const self = sessions.find((s) => s.id === id);
  if (!self || !live(self)) return null;
  const others = sessions.filter((s) => s.id !== id && live(s));

  const sameDir = others.filter((s) => s.cwd === self.cwd);
  if (sameDir.length > 0) return { kind: 'directory', cwd: self.cwd, branch: self.branch, others: sameDir };

  const sameBranch = self.branch
    ? others.filter((s) => s.branch === self.branch && s.repo === self.repo)
    : [];
  if (sameBranch.length > 0) return { kind: 'branch', cwd: self.cwd, branch: self.branch, others: sameBranch };
  return null;
}
