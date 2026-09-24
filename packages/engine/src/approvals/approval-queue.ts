import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { ApprovalDecision, PendingApproval } from '@relay/shared';
import { classifyToolUse, tooBroadPattern } from './rules';

/** Where allowed kinds are kept, so a decision outlives the runner and the app. */
export interface AllowedPatternStore {
  allowedPatterns(): { sessionId: string; patternKey: string }[];
  allowPattern(sessionId: string, patternKey: string): void;
}

export type PermissionOutcome = { behavior: 'allow' } | { behavior: 'deny'; message: string };

export interface ApprovalRequest {
  sessionId: string;
  toolName: string;
  input: Record<string, unknown>;
  cwd: string;
  blockedPath?: string;
  signal: AbortSignal;
}

type Waiting = {
  approval: PendingApproval;
  patternKey: string;
  resolve: (o: PermissionOutcome) => void;
  signal: AbortSignal;
  onAbort: () => void;
};

type QueueEvents = { pending: [PendingApproval]; resolved: [string, ApprovalDecision['kind']] };

/** Turns `canUseTool` callbacks into pending decisions; safe calls pass straight through. */
export class ApprovalQueue extends EventEmitter<QueueEvents> {
  private readonly waiting = new Map<string, Waiting>();
  /** Per session: kinds of call the user allowed, kept for good rather than for one run. */
  private readonly allowed = new Map<string, Set<string>>();

  constructor(private readonly store?: AllowedPatternStore) {
    super();
    for (const { sessionId, patternKey } of store?.allowedPatterns() ?? []) {
      // one stored by an earlier version could cover the whole disk; it is not honoured again
      if (!tooBroadPattern(patternKey)) this.remember(sessionId, patternKey);
    }
  }

  private remember(sessionId: string, patternKey: string): void {
    const set = this.allowed.get(sessionId) ?? new Set<string>();
    set.add(patternKey);
    this.allowed.set(sessionId, set);
  }

  /** True when the call must wait for the user, whatever the session's own settings allow. */
  needsApproval(req: Omit<ApprovalRequest, 'signal'>): boolean {
    const verdict = classifyToolUse(req.toolName, req.input, req.cwd, req.blockedPath);
    return verdict.outcome === 'ask' && !this.allowed.get(req.sessionId)?.has(verdict.patternKey);
  }

  request(req: ApprovalRequest): Promise<PermissionOutcome> {
    const verdict = classifyToolUse(req.toolName, req.input, req.cwd, req.blockedPath);
    if (verdict.outcome === 'allow') return Promise.resolve({ behavior: 'allow' });
    if (this.allowed.get(req.sessionId)?.has(verdict.patternKey)) return Promise.resolve({ behavior: 'allow' });
    if (req.signal.aborted) return Promise.resolve({ behavior: 'deny', message: 'aborted' });
    const approval: PendingApproval = {
      id: randomUUID(),
      sessionId: req.sessionId,
      toolName: req.toolName,
      input: req.input,
      summary: verdict.summary,
      reason: verdict.reason,
      cwd: req.cwd,
      createdAt: new Date().toISOString(),
    };
    return new Promise((resolve) => {
      const onAbort = () => this.settle(approval.id, { behavior: 'deny', message: 'aborted' }, 'deny');
      req.signal.addEventListener('abort', onAbort, { once: true });
      this.waiting.set(approval.id, { approval, patternKey: verdict.patternKey, resolve, signal: req.signal, onAbort });
      this.emit('pending', approval);
    });
  }

  decide(approvalId: string, decision: ApprovalDecision): void {
    const w = this.waiting.get(approvalId);
    if (!w) throw new Error(`Unknown approval ${approvalId}`);
    switch (decision.kind) {
      case 'allow-once':
        this.settle(approvalId, { behavior: 'allow' }, 'allow-once');
        break;
      case 'allow-pattern': {
        this.remember(w.approval.sessionId, w.patternKey);
        this.store?.allowPattern(w.approval.sessionId, w.patternKey);
        this.settle(approvalId, { behavior: 'allow' }, 'allow-pattern');
        break;
      }
      case 'deny':
        this.settle(approvalId, { behavior: 'deny', message: decision.message ?? 'denied by user' }, 'deny');
        break;
    }
  }

  pending(): PendingApproval[] {
    return [...this.waiting.values()].map((w) => w.approval);
  }

  /** Denies every pending item of a session, e.g. on interrupt or when its run dies. */
  cancelSession(sessionId: string, message: string): void {
    for (const [id, w] of this.waiting) {
      if (w.approval.sessionId === sessionId) this.settle(id, { behavior: 'deny', message }, 'deny');
    }
  }


  private settle(id: string, outcome: PermissionOutcome, kind: ApprovalDecision['kind']): void {
    const w = this.waiting.get(id);
    if (!w) return;
    this.waiting.delete(id);
    w.signal.removeEventListener('abort', w.onAbort);
    w.resolve(outcome);
    this.emit('resolved', id, kind);
  }
}
