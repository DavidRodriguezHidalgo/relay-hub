/** What a session has actually produced, and what it still has open. */
export interface Accomplished {
  /** Commits this session is responsible for, newest first. */
  commits: { sha: string; subject: string; at: string }[];
  /** Commits beyond the few listed. */
  moreCommits: number;
  /** Files this session itself wrote. */
  files: string[];
  /** More files than are listed, when there were too many to show. */
  moreFiles: number;
  /** What the base was compared against, or null when none could be worked out. */
  base: string | null;
  /** Anything still waiting: approvals, unanswered instructions, a watch that could not wake. */
  open: string[];
  /** Why the comparison is missing, when it is. */
  note: string | null;
}
