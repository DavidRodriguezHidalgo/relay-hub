import type { QueuedMessage } from './queue';
import type { Todo } from './todo';
import type { TranscriptEntry } from './transcript';

/** `sessionId` used by runner events that belong to the orchestrator itself. */
export const ORCHESTRATOR_KEY = 'orchestrator';

export type SessionState = 'idle' | 'running' | 'waiting-approval' | 'error';

export type DeliveryMode = 'steer' | 'queue' | 'interrupt';

export type MessageOrigin = 'user' | 'orchestrator' | 'aside' | `watch:${string}` | `bulk:${string}`;

/** A transcript entry produced while Relay drives the session; `origin` names who caused the turn. */
export interface LiveEntry extends TranscriptEntry {
  origin: MessageOrigin | null;
  /** Relay's own words about the turn, such as it having been stopped; not the agent's. */
  notice?: string;
}

export type ApprovalReason = 'destructive-git' | 'outside-cwd' | 'blocked-path';

export interface PendingApproval {
  id: string;
  sessionId: string;
  toolName: string;
  input: Record<string, unknown>;
  /** One line for the UI, e.g. the shell command or the file path. */
  summary: string;
  reason: ApprovalReason;
  cwd: string;
  createdAt: string;
}

export type ApprovalDecision =
  | { kind: 'allow-once' }
  | { kind: 'deny'; message?: string }
  /** Allow this tool + command head again without asking, for the life of the current runner. */
  | { kind: 'allow-pattern' };

export type BulkRowStatus = 'proposed' | 'skipped' | 'queued' | 'running' | 'done' | 'error';

export interface BulkRow {
  sessionId: string;
  title: string;
  branch: string | null;
  prompt: string;
  status: BulkRowStatus;
  /** Last reply on done, the reason on error. */
  detail: string | null;
}

export type BulkRunStatus = 'proposed' | 'cancelled' | 'running' | 'finished';

/** One instruction for many sessions, confirmed by the user before anything runs. */
export interface BulkRun {
  id: string;
  createdAt: string;
  mode: DeliveryMode;
  status: BulkRunStatus;
  rows: BulkRow[];
}

export type PrEventKind = 'ci_failed' | 'review_comment' | 'base_moved' | 'merged';

/** Something that changed on a watched PR; `details` is the message the session is woken with. */
export interface PrEvent {
  kind: PrEventKind;
  summary: string;
  details: string;
}

export interface PrWatch {
  id: string;
  sessionId: string;
  /** owner/name */
  repo: string;
  prNumber: number;
  prUrl: string;
  active: boolean;
  createdAt: string;
  lastPolledAt: string | null;
  /** The last poll failed (gh unavailable, PR not found...). */
  lastError: string | null;
  /** The last wake-up was refused (e.g. the session is open elsewhere); kept until a wake succeeds. */
  wakeError?: string | null;
}

/** Sessions open in another Claude process (a terminal, the desktop app), by id: busy or idle. */
export type ExternalSessions = Record<string, 'busy' | 'idle'>;

export type GhStatus = { state: 'ok' } | { state: 'unavailable'; message: string };

export type RunnerEvent =
  | { type: 'state'; sessionId: string; state: SessionState; error: string | null }
  | { type: 'entry'; sessionId: string; entry: LiveEntry }
  | { type: 'approval'; approval: PendingApproval }
  | { type: 'approval-resolved'; approvalId: string; decision: ApprovalDecision['kind'] }
  | { type: 'bulk'; run: BulkRun }
  | { type: 'watch'; watch: PrWatch; gh: GhStatus }
  | { type: 'watch-removed'; watchId: string; gh: GhStatus }
  | { type: 'external'; external: ExternalSessions }
  | { type: 'queue'; sessionId: string; queue: QueuedMessage[] }
  | { type: 'pr-event'; sessionId: string; watchId: string; event: PrEvent }
  /** The whole list, whenever it changes, whoever changed it: the panel and the chat share one copy. */
  | { type: 'todos'; todos: Todo[] };

export interface RunState {
  states: Record<string, { state: SessionState; error: string | null }>;
  approvals: PendingApproval[];
  bulkRuns: BulkRun[];
  watches: PrWatch[];
  gh: GhStatus;
  external: ExternalSessions;
  /** Recent instructions per session, and what became of each. */
  queue: Record<string, QueuedMessage[]>;
}
