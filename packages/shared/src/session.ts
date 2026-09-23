/** One Claude Code session as shown in the session list. */
export interface SessionSummary {
  id: string;
  filePath: string;
  cwd: string;
  cwdExists: boolean;
  /** Directory name of the main repo; worktrees share it. */
  repo: string;
  branch: string | null;
  title: string;
  /** ISO timestamp of the newest user or assistant entry. */
  lastActivity: string;
  /** Count of non-sidechain user and assistant entries. */
  messageCount: number;
  prNumber: number | null;
  prUrl: string | null;
  /** Session id this one was continued in, if any. */
  continuedIn: string | null;
  isStale: boolean;
}
