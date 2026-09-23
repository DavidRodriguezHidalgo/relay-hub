import { stat } from 'node:fs/promises';
import type {
  ApprovalDecision,
  DeliveryMode,
  MessageOrigin,
  RunnerEvent,
  RunState,
  SessionSummary,
  TranscriptEntry,
} from '@relay/shared';
import { ApprovalQueue } from './approvals/approval-queue';
import { ExecGitInfoProvider, type GitInfoProvider } from './git/git-info';
import { SessionIndex } from './index/session-index';
import type { AgentClient } from './runner/agent-client';
import { SdkAgentClient } from './runner/sdk-agent-client';
import { SessionBusyError } from './runner/session-busy-error';
import { SessionRunner } from './runner/session-runner';
import { SessionStore } from './store/session-store';

/** A transcript written more recently than this is assumed to have another writer. */
const BUSY_WINDOW_MS = 15_000;
/** Writes this soon after Relay's own run went idle are Relay's, not a terminal's. */
const OWN_WRITE_GRACE_MS = 1_000;
/** An idle runner (and its `claude` process) is closed after this long without a send. */
const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60 * 1_000;

export interface RelayEngineOptions {
  projectsDir: string;
  dbPath: string;
  git?: GitInfoProvider;
  agent?: AgentClient;
  now?: () => Date;
  idleTimeoutMs?: number;
}

export interface SendOptions {
  sessionId: string;
  prompt: string;
  mode: DeliveryMode;
  origin: MessageOrigin;
}

/** The single entry point the desktop app (and later a daemon) talks to. */
export class RelayEngine {
  private readonly runners = new Map<string, SessionRunner>();
  private readonly creating = new Map<string, Promise<SessionRunner>>();
  private readonly idleTimers = new Map<string, NodeJS.Timeout>();
  private readonly listeners = new Set<(e: RunnerEvent) => void>();

  private constructor(
    private readonly store: SessionStore,
    private readonly index: SessionIndex,
    private readonly agent: AgentClient,
    private readonly approvals: ApprovalQueue,
    private readonly now: () => Date,
    private readonly idleTimeoutMs: number,
  ) {
    approvals.on('pending', (approval) => this.publish({ type: 'approval', approval }));
    approvals.on('resolved', (approvalId, decision) =>
      this.publish({ type: 'approval-resolved', approvalId, decision }),
    );
  }

  static async start(opts: RelayEngineOptions): Promise<RelayEngine> {
    const store = new SessionStore(opts.dbPath);
    const index = new SessionIndex({
      projectsDir: opts.projectsDir,
      store,
      git: opts.git ?? new ExecGitInfoProvider(),
    });
    await index.scan();
    index.watch();
    return new RelayEngine(
      store,
      index,
      opts.agent ?? new SdkAgentClient(),
      new ApprovalQueue(),
      opts.now ?? (() => new Date()),
      opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS,
    );
  }

  listSessions(): SessionSummary[] {
    return this.index.list();
  }

  getTranscript(id: string): Promise<TranscriptEntry[]> {
    return this.index.getTranscript(id);
  }

  onSessionsChanged(listener: (sessions: SessionSummary[]) => void): () => void {
    this.index.on('changed', listener);
    return () => this.index.off('changed', listener);
  }

  /** Non-fatal indexing problems (an unreadable transcript, a failed rescan). */
  onError(listener: (error: Error) => void): () => void {
    this.index.on('error', listener);
    return () => this.index.off('error', listener);
  }

  onEvent(listener: (event: RunnerEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Refuses when another process is writing the transcript; a runner is created on first use. */
  async send(opts: SendOptions): Promise<string> {
    const existing = this.runners.get(opts.sessionId);
    if (existing) {
      if (existing.state === 'idle' || existing.state === 'error') {
        await this.assertNotBusy(opts.sessionId, existing.idleSince + OWN_WRITE_GRACE_MS);
      }
      return existing.send(opts.prompt, { mode: opts.mode, origin: opts.origin });
    }
    const runner = await this.runnerFor(opts.sessionId);
    return runner.send(opts.prompt, { mode: opts.mode, origin: opts.origin });
  }

  async interrupt(sessionId: string): Promise<void> {
    await this.runners.get(sessionId)?.interrupt();
  }

  decide(approvalId: string, decision: ApprovalDecision): void {
    this.approvals.decide(approvalId, decision);
  }

  runState(): RunState {
    const states: RunState['states'] = {};
    for (const [id, r] of this.runners) states[id] = { state: r.state, error: r.error };
    return { states, approvals: this.approvals.pending() };
  }

  async close(): Promise<void> {
    for (const t of this.idleTimers.values()) clearTimeout(t);
    this.idleTimers.clear();
    await Promise.all([...this.runners.values()].map((r) => r.close()));
    this.runners.clear();
    await this.index.close();
    this.store.close();
  }

  /** One creation per session at a time, so two quick sends share a single run. */
  private runnerFor(sessionId: string): Promise<SessionRunner> {
    let creating = this.creating.get(sessionId);
    if (!creating) {
      creating = this.createRunner(sessionId).finally(() => this.creating.delete(sessionId));
      this.creating.set(sessionId, creating);
    }
    return creating;
  }

  private async createRunner(sessionId: string): Promise<SessionRunner> {
    const session = this.index.list().find((s) => s.id === sessionId);
    if (!session) throw new Error(`Unknown session ${sessionId}`);
    await this.assertNotBusy(sessionId, 0);
    const runner = new SessionRunner({ sessionId, cwd: session.cwd, client: this.agent, approvals: this.approvals });
    runner.on('state', (state, error) => {
      this.publish({ type: 'state', sessionId, state, error });
      this.scheduleIdleClose(sessionId, state);
    });
    runner.on('entry', (entry) => this.publish({ type: 'entry', sessionId, entry }));
    this.runners.set(sessionId, runner);
    return runner;
  }

  /** Throws when the transcript was written recently by someone other than Relay's own run. */
  private async assertNotBusy(sessionId: string, ownWritesUntil: number): Promise<void> {
    const session = this.index.list().find((s) => s.id === sessionId);
    if (!session) throw new Error(`Unknown session ${sessionId}`);
    const { mtimeMs } = await stat(session.filePath);
    const recent = this.now().getTime() - mtimeMs < BUSY_WINDOW_MS;
    if (recent && mtimeMs > ownWritesUntil) throw new SessionBusyError(sessionId);
  }

  private scheduleIdleClose(sessionId: string, state: SessionRunner['state']): void {
    const existing = this.idleTimers.get(sessionId);
    if (existing) clearTimeout(existing);
    this.idleTimers.delete(sessionId);
    if (state !== 'idle' && state !== 'error') return;
    const timer = setTimeout(() => {
      this.idleTimers.delete(sessionId);
      const runner = this.runners.get(sessionId);
      if (!runner || (runner.state !== 'idle' && runner.state !== 'error')) return;
      this.runners.delete(sessionId);
      void runner.close();
    }, this.idleTimeoutMs);
    timer.unref?.();
    this.idleTimers.set(sessionId, timer);
  }

  private publish(event: RunnerEvent): void {
    for (const l of this.listeners) l(event);
  }
}
