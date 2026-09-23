import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { DeliveryMode, LiveEntry, MessageOrigin, PendingApproval, SessionState } from '@relay/shared';
import type { ApprovalQueue } from '../approvals/approval-queue';
import type { AgentClient, AgentInput, AgentRun } from './agent-client';
import { AsyncQueue } from './async-queue';

export interface SessionRunnerOptions {
  sessionId: string;
  cwd: string;
  client: AgentClient;
  approvals: ApprovalQueue;
}

type RunnerEvents = { state: [SessionState, string | null]; entry: [LiveEntry] };

/** Drives one session: owns the agent run, tracks its state and relays its output. */
export class SessionRunner extends EventEmitter<RunnerEvents> {
  readonly sessionId: string;
  private readonly cwd: string;
  private readonly client: AgentClient;
  private readonly approvals: ApprovalQueue;
  private input: AsyncQueue<AgentInput> | null = null;
  private run: AgentRun | null = null;
  private consuming: Promise<void> | null = null;
  /** Sends whose turn has not produced a result yet. */
  private outstanding = 0;
  private lastOrigin: MessageOrigin | null = null;
  /** Ids of this session's approvals still waiting for a decision. */
  private readonly pendingIds = new Set<string>();
  private _state: SessionState = 'idle';
  private _error: string | null = null;
  private readonly onPending = (p: PendingApproval) => {
    if (p.sessionId !== this.sessionId) return;
    this.pendingIds.add(p.id);
    this.setState('waiting-approval');
  };
  private readonly onResolved = (id: string) => {
    if (!this.pendingIds.delete(id)) return;
    if (this.pendingIds.size === 0 && this._state === 'waiting-approval') this.setState('running');
  };

  constructor(opts: SessionRunnerOptions) {
    super();
    this.sessionId = opts.sessionId;
    this.cwd = opts.cwd;
    this.client = opts.client;
    this.approvals = opts.approvals;
    this.approvals.on('pending', this.onPending);
    this.approvals.on('resolved', this.onResolved);
  }

  get state(): SessionState {
    return this._state;
  }

  get error(): string | null {
    return this._error;
  }

  /** The first send starts the run; later sends reuse it. Returns a message id. */
  async send(prompt: string, opts: { mode: DeliveryMode; origin: MessageOrigin }): Promise<string> {
    if (!this.run) this.startRun();
    if (opts.mode === 'interrupt') await this.interrupt();
    this.outstanding += 1;
    this.lastOrigin = opts.origin;
    this.input!.push({ text: prompt, priority: opts.mode === 'queue' ? 'next' : 'now', origin: opts.origin });
    this.setState('running');
    return randomUUID();
  }

  async interrupt(): Promise<void> {
    if (!this.run) return;
    this.approvals.cancelSession(this.sessionId, 'interrupted');
    await this.run.interrupt();
  }

  async close(): Promise<void> {
    this.approvals.cancelSession(this.sessionId, 'session closed');
    this.approvals.forgetSession(this.sessionId);
    this.approvals.off('pending', this.onPending);
    this.approvals.off('resolved', this.onResolved);
    this.input?.end();
    await this.consuming;
    this.run = null;
    this.input = null;
  }

  private startRun(): void {
    this._error = null;
    this.input = new AsyncQueue<AgentInput>();
    this.run = this.client.start({
      sessionId: this.sessionId,
      cwd: this.cwd,
      input: this.input,
      canUseTool: (toolName, input, blockedPath, signal) =>
        this.approvals.request({ sessionId: this.sessionId, toolName, input, cwd: this.cwd, blockedPath, signal }),
    });
    this.consuming = this.consume(this.run).catch((err: unknown) =>
      this.fail(err instanceof Error ? err.message : String(err)),
    );
  }

  private async consume(run: AgentRun): Promise<void> {
    for await (const m of run.messages) {
      switch (m.type) {
        case 'assistant':
        case 'tool-results':
          this.emit('entry', {
            uuid: m.uuid,
            role: m.type === 'assistant' ? 'assistant' : 'user',
            timestamp: m.timestamp,
            isSidechain: false,
            isMeta: false,
            blocks: m.blocks,
            origin: this.lastOrigin,
          });
          break;
        case 'result':
          if (m.isError) {
            this.fail(m.error ?? 'unknown error');
            return;
          }
          this.outstanding = Math.max(0, this.outstanding - 1);
          if (this.outstanding === 0 && this.pendingIds.size === 0) this.setState('idle');
          break;
        case 'init':
          break;
      }
    }
  }

  /** Drops the run so the next send starts a fresh one; pending approvals are denied first. */
  private fail(reason: string): void {
    this.approvals.cancelSession(this.sessionId, reason);
    this.input?.end();
    this.run = null;
    this.input = null;
    this.outstanding = 0;
    this.pendingIds.clear();
    this._error = reason;
    this.setState('error');
  }

  private setState(state: SessionState): void {
    if (state === this._state) return;
    this._state = state;
    this.emit('state', state, this._error);
  }
}
