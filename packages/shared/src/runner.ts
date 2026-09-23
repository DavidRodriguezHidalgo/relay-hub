import type { TranscriptEntry } from './transcript';

/** `sessionId` used by runner events that belong to the orchestrator itself. */
export const ORCHESTRATOR_KEY = 'orchestrator';

export type SessionState = 'idle' | 'running' | 'waiting-approval' | 'error';

export type DeliveryMode = 'steer' | 'queue' | 'interrupt';

export type MessageOrigin = 'user' | 'orchestrator' | `watch:${string}` | `bulk:${string}`;

/** A transcript entry produced while Relay drives the session; `origin` names who caused the turn. */
export interface LiveEntry extends TranscriptEntry {
  origin: MessageOrigin | null;
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

export type RunnerEvent =
  | { type: 'state'; sessionId: string; state: SessionState; error: string | null }
  | { type: 'entry'; sessionId: string; entry: LiveEntry }
  | { type: 'approval'; approval: PendingApproval }
  | { type: 'approval-resolved'; approvalId: string; decision: ApprovalDecision['kind'] }
  | { type: 'bulk'; run: BulkRun };

export interface RunState {
  states: Record<string, { state: SessionState; error: string | null }>;
  approvals: PendingApproval[];
  bulkRuns: BulkRun[];
}
