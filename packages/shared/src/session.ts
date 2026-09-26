import type { ModelInEffect } from './model-in-effect';
import type { ContextUse } from './context';
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
  /** How full this session’s context was at its last request; null if it never called the model. */
  context: ContextUse | null;
  /** The model this session runs on, and how that is known; absent until the engine works it out. */
  model?: ModelInEffect | null;
  isStale: boolean;
}
