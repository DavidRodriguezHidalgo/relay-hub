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

export interface RelayEngineOptions {
  projectsDir: string;
  dbPath: string;
  git?: GitInfoProvider;
  agent?: AgentClient;
  now?: () => Date;
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
  private readonly listeners = new Set<(e: RunnerEvent) => void>();

  private constructor(
    private readonly store: SessionStore,
    private readonly index: SessionIndex,
    private readonly agent: AgentClient,
    private readonly approvals: ApprovalQueue,
    private readonly now: () => Date,
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

  async send(opts: SendOptions): Promise<string> {
    const runner = this.runners.get(opts.sessionId) ?? (await this.createRunner(opts.sessionId));
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
    await Promise.all([...this.runners.values()].map((r) => r.close()));
    await this.index.close();
    this.store.close();
  }

  private async createRunner(sessionId: string): Promise<SessionRunner> {
    const session = this.index.list().find((s) => s.id === sessionId);
    if (!session) throw new Error(`Unknown session ${sessionId}`);
    const { mtimeMs } = await stat(session.filePath);
    if (this.now().getTime() - mtimeMs < BUSY_WINDOW_MS) throw new SessionBusyError(sessionId);
    const runner = new SessionRunner({ sessionId, cwd: session.cwd, client: this.agent, approvals: this.approvals });
    runner.on('state', (state, error) => this.publish({ type: 'state', sessionId, state, error }));
    runner.on('entry', (entry) => this.publish({ type: 'entry', sessionId, entry }));
    this.runners.set(sessionId, runner);
    return runner;
  }

  private publish(event: RunnerEvent): void {
    for (const l of this.listeners) l(event);
  }
}
