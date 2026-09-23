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
  /** How long `close()` waits for the run to wind down after interrupting it. */
  closeTimeoutMs?: number;
}

type RunnerEvents = { state: [SessionState, string | null]; entry: [LiveEntry] };

/** Drives one session: owns the agent run, tracks its state and relays its output. */
export class SessionRunner extends EventEmitter<RunnerEvents> {
  readonly sessionId: string;
  private readonly cwd: string;
  private readonly client: AgentClient;
  private readonly approvals: ApprovalQueue;
  private readonly closeTimeoutMs: number;
  private input: AsyncQueue<AgentInput> | null = null;
  private run: AgentRun | null = null;
  private consuming: Promise<void> | null = null;
  /** Sends no turn result has settled yet. */
  private readonly outstanding = new Set<string>();
  /** Sends in flight when the current interrupt fired; the aborted turn's result settles only these. */
  private aborting: Set<string> | null = null;
  private lastOrigin: MessageOrigin | null = null;
  /** Ids of this session's approvals still waiting for a decision. */
  private readonly pendingIds = new Set<string>();
  private _state: SessionState = 'idle';
  private _error: string | null = null;
  /** When the runner last became idle; lets the engine tell Relay's own transcript writes from a terminal's. */
  private _idleSince: number = Date.now();
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
    this.closeTimeoutMs = opts.closeTimeoutMs ?? 5_000;
    this.approvals.on('pending', this.onPending);
    this.approvals.on('resolved', this.onResolved);
  }

  get state(): SessionState {
    return this._state;
  }

  get error(): string | null {
    return this._error;
  }

  get idleSince(): number {
    return this._idleSince;
  }

  /** The first send starts the run; later sends reuse it. Returns the send id. */
  async send(prompt: string, opts: { mode: DeliveryMode; origin: MessageOrigin }): Promise<string> {
    if (!this.run) this.startRun();
    if (opts.mode === 'interrupt') await this.interrupt();
    const id = randomUUID();
    this.outstanding.add(id);
    this.lastOrigin = opts.origin;
    this.input!.push({ id, text: prompt, priority: opts.mode === 'queue' ? 'next' : 'now', origin: opts.origin });
    this.setState('running');
    return id;
  }

  async interrupt(): Promise<void> {
    if (!this.run) return;
    this.approvals.cancelSession(this.sessionId, 'interrupted');
    if (this.outstanding.size > 0) this.aborting = new Set(this.outstanding);
    await this.run.interrupt();
  }

  /** Interrupts the run, ends its input and waits (bounded) for it to wind down. */
  async close(): Promise<void> {
    this.approvals.cancelSession(this.sessionId, 'session closed');
    this.approvals.forgetSession(this.sessionId);
    this.approvals.off('pending', this.onPending);
    this.approvals.off('resolved', this.onResolved);
    if (this.run && this._state !== 'idle') {
      await this.run.interrupt().catch(() => undefined);
    }
    this.input?.end();
    if (this.consuming) {
      await Promise.race([this.consuming, new Promise((r) => setTimeout(r, this.closeTimeoutMs))]);
    }
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
          // Output means a turn is in progress, whatever the last result said.
          if (this._state === 'idle') this.setState('running');
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
          this.settleTurn(m.settledSendIds, m.queuedTurns);
          break;
        case 'init':
          break;
      }
    }
  }

  /**
   * One result ends one turn. Sends the runtime names are settled; when it reports no
   * queued turns, every earlier send was folded into this turn and is settled too.
   */
  private settleTurn(settledSendIds: string[], queuedTurns: number | null): void {
    for (const id of settledSendIds) this.outstanding.delete(id);
    if (this.aborting) {
      // the interrupted turn ends: it settles what it was running, not what was sent after the interrupt
      for (const id of this.aborting) this.outstanding.delete(id);
      this.aborting = null;
    } else if (queuedTurns === null || queuedTurns === 0) {
      this.outstanding.clear();
    }
    if (this.outstanding.size === 0 && this.pendingIds.size === 0) this.setState('idle');
  }

  /** Drops the run so the next send starts a fresh one; pending approvals are denied first. */
  private fail(reason: string): void {
    const dropped = this.outstanding.size;
    this.approvals.cancelSession(this.sessionId, reason);
    this.input?.end();
    this.run = null;
    this.input = null;
    this.outstanding.clear();
    this.aborting = null;
    this.pendingIds.clear();
    this._error = dropped > 1 ? `${reason} (${dropped - 1} queued message${dropped > 2 ? 's' : ''} dropped)` : reason;
    this.setState('error');
  }

  private setState(state: SessionState): void {
    if (state === this._state) return;
    this._state = state;
    if (state === 'idle') this._idleSince = Date.now();
    this.emit('state', state, this._error);
  }
}
