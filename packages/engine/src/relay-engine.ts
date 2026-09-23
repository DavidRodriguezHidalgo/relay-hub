import { mkdir, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  ORCHESTRATOR_KEY,
  type ApprovalDecision,
  type BulkRowStatus,
  type BulkRun,
  type DeliveryMode,
  type MessageOrigin,
  type RunnerEvent,
  type RunState,
  type SessionSummary,
  type TranscriptEntry,
} from '@relay/shared';
import { ApprovalQueue } from './approvals/approval-queue';
import { BulkRuns, repairLoadedRuns } from './bulk/bulk-runs';
import { ExecGitInfoProvider, type GitInfoProvider } from './git/git-info';
import { SessionIndex } from './index/session-index';
import { Orchestrator } from './orchestrator/orchestrator';
import { createRelayTools } from './orchestrator/relay-tools';
import type { AgentClient } from './runner/agent-client';
import { SdkAgentClient } from './runner/sdk-agent-client';
import { SessionBusyError } from './runner/session-busy-error';
import { ClaudeSessionRegistry, type SessionRegistry } from './runner/session-registry';
import { SessionRunner, type TurnEnd } from './runner/session-runner';
import { SessionStore } from './store/session-store';

/** A transcript written more recently than this is assumed to have another writer. */
const BUSY_WINDOW_MS = 15_000;
/** Writes this soon after Relay's own run went idle are Relay's, not a terminal's. */
const OWN_WRITE_GRACE_MS = 1_000;
/** An idle runner (and its `claude` process) is closed after this long without a send. */
const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60 * 1_000;
/** How much of a session's last reply the completion relay passes to the orchestrator. */
const RELAY_TEXT_MAX = 600;
/** Per-row detail in a bulk summary. */
const BULK_DETAIL_MAX = 200;
const RECENT_BULK_RUNS = 20;
const RELAY_ONLY_REFUSAL =
  'This turn was started by a session finishing, not by the user. Report the result and ask the user before sending anything else.';

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);

export interface RelayEngineOptions {
  projectsDir: string;
  dbPath: string;
  /** Working directory of the orchestrator's own sessions; created if missing. */
  orchestratorDir: string;
  git?: GitInfoProvider;
  agent?: AgentClient;
  now?: () => Date;
  idleTimeoutMs?: number;
  registry?: SessionRegistry;
  /** Rows of one bulk run that run at once; defaults to BULK_CONCURRENCY. */
  bulkConcurrency?: number;
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
  private readonly orchestrator: Orchestrator;
  private readonly bulk: BulkRuns;
  private readonly orchestratorCwd: string;
  private closing = false;

  private constructor(
    private readonly store: SessionStore,
    private readonly index: SessionIndex,
    private readonly agent: AgentClient,
    private readonly approvals: ApprovalQueue,
    private readonly now: () => Date,
    private readonly idleTimeoutMs: number,
    private readonly registry: SessionRegistry,
    orchestratorDir: string,
    loadedBulkRuns: BulkRun[],
    bulkConcurrency: number | undefined,
  ) {
    this.bulk = new BulkRuns({ send: (req) => this.send(req), concurrency: bulkConcurrency }, loadedBulkRuns);
    this.bulk.on('changed', (run) => {
      this.store.saveBulkRun(run);
      this.publish({ type: 'bulk', run });
    });
    this.bulk.on('finished', (run) => this.relayBulkEnd(run));
    this.orchestratorCwd = resolve(orchestratorDir);
    this.orchestrator = new Orchestrator({
      cwd: this.orchestratorCwd,
      client: agent,
      approvals,
      store,
      tools: createRelayTools({
        listSessions: () => this.listSessions(),
        runState: () => this.runState(),
        getTranscript: (id) => this.getTranscript(id),
        send: async (req) => {
          this.refuseRelayOnly();
          return this.send(req);
        },
        proposeBulk: async (targets, mode) => {
          this.refuseRelayOnly();
          return this.proposeBulk(targets, mode);
        },
        interrupt: (id) => this.interrupt(id),
      }),
    });
    this.orchestrator.on('state', (state, error) =>
      this.publish({ type: 'state', sessionId: ORCHESTRATOR_KEY, state, error }),
    );
    this.orchestrator.on('entry', (entry) => this.publish({ type: 'entry', sessionId: ORCHESTRATOR_KEY, entry }));
    approvals.on('pending', (approval) => this.publish({ type: 'approval', approval }));
    approvals.on('resolved', (approvalId, decision) =>
      this.publish({ type: 'approval-resolved', approvalId, decision }),
    );
  }

  static async start(opts: RelayEngineOptions): Promise<RelayEngine> {
    await mkdir(opts.orchestratorDir, { recursive: true });
    const store = new SessionStore(opts.dbPath);
    const loadedBulkRuns = repairLoadedRuns(store.loadBulkRuns(RECENT_BULK_RUNS));
    for (const run of loadedBulkRuns) store.saveBulkRun(run);
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
      opts.registry ?? new ClaudeSessionRegistry(),
      opts.orchestratorDir,
      loadedBulkRuns,
      opts.bulkConcurrency,
    );
  }

  /** Every session except the orchestrator's own, which must never be listed or targeted. */
  listSessions(): SessionSummary[] {
    return this.index.list().filter((s) => resolve(s.cwd) !== this.orchestratorCwd);
  }

  getTranscript(id: string): Promise<TranscriptEntry[]> {
    return this.index.getTranscript(id);
  }

  onSessionsChanged(listener: (sessions: SessionSummary[]) => void): () => void {
    const filtered = () => listener(this.listSessions());
    this.index.on('changed', filtered);
    return () => this.index.off('changed', filtered);
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

  orchestratorSend(prompt: string): Promise<string> {
    return this.orchestrator.send(prompt);
  }

  orchestratorInterrupt(): Promise<void> {
    return this.orchestrator.interrupt();
  }

  /** The orchestrator's conversation so far; empty until it has a session on disk. */
  async orchestratorHistory(): Promise<TranscriptEntry[]> {
    const id = this.orchestrator.sessionId;
    if (!id) return [];
    try {
      return await this.index.getTranscript(id);
    } catch {
      return [];
    }
  }

  bulkConfirm(runId: string, sessionIds: string[]): void {
    this.bulk.confirm(runId, sessionIds);
  }

  bulkCancel(runId: string): void {
    this.bulk.cancel(runId);
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
    return { states, approvals: this.approvals.pending(), bulkRuns: this.bulk.recent(RECENT_BULK_RUNS),
      watches: [],
      gh: { state: 'ok' },
    };
  }

  async close(): Promise<void> {
    for (const t of this.idleTimers.values()) clearTimeout(t);
    this.idleTimers.clear();
    // Sessions first, with the relay off: their interrupted turns must not wake the orchestrator.
    this.closing = true;
    this.bulk.stop();
    await Promise.all([...this.runners.values()].map((r) => r.close()));
    await this.orchestrator.close();
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
    const session = this.listSessions().find((s) => s.id === sessionId);
    if (!session) throw new Error(`Unknown session ${sessionId}`);
    await this.assertNotBusy(sessionId, 0);
    const runner = new SessionRunner({ sessionId, cwd: session.cwd, client: this.agent, approvals: this.approvals });
    runner.on('state', (state, error) => {
      this.publish({ type: 'state', sessionId, state, error });
      this.scheduleIdleClose(sessionId, state);
    });
    runner.on('entry', (entry) => this.publish({ type: 'entry', sessionId, entry }));
    runner.on('turn-end', (end) => this.bulk.onTurnEnd(sessionId, end));
    runner.on('turn-end', (end) => this.relayTurnEnd(session, end));
    this.runners.set(sessionId, runner);
    return runner;
  }

  /**
   * Throws when another live Claude process holds the session (Claude Code's own registry),
   * or, as a fallback, when its transcript was written recently by someone other than Relay.
   */
  private async assertNotBusy(sessionId: string, ownWritesUntil: number): Promise<void> {
    const session = this.listSessions().find((s) => s.id === sessionId);
    if (!session) throw new Error(`Unknown session ${sessionId}`);
    const holders = await this.registry.foreignHolders(sessionId);
    if (holders.length > 0) throw new SessionBusyError(sessionId, holders);
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

  /** Tells the orchestrator how a turn it started ended; turns the user started stay quiet. */
  private relayTurnEnd(session: SessionSummary, end: TurnEnd): void {
    if (this.closing || !end.origins.includes('orchestrator')) return;
    const where = `session "${session.title}" (${session.id}${session.branch ? `, ${session.branch}` : ''})`;
    const reply = end.lastText ? clip(end.lastText, RELAY_TEXT_MAX) : '(no text)';
    const outcome = end.error
      ? ` finished with an error: ${end.error}`
      : end.aborted
        ? ` was interrupted. Last reply: ${reply}`
        : ` finished. Last reply: ${reply}`;
    void this.orchestrator.send(`[turn-end] ${where}${outcome}`, { origin: 'watch:turn-end', mode: 'queue' });
  }

  /** The orchestrator must not act on its own after a relay: only the user starts sends. */
  private refuseRelayOnly(): void {
    if (this.orchestrator.onlyRelayPending) throw new Error(RELAY_ONLY_REFUSAL);
  }

  /** Resolves targets to listed sessions (the whole plan is refused on an unknown id) and proposes the run. */
  private proposeBulk(targets: { sessionId: string; prompt: string }[], mode: DeliveryMode): BulkRun {
    const known = this.listSessions();
    const seen = new Set<string>();
    const resolved = [];
    for (const t of targets) {
      if (seen.has(t.sessionId)) continue;
      seen.add(t.sessionId);
      const s = known.find((x) => x.id === t.sessionId);
      if (!s) throw new Error(`Unknown session ${t.sessionId}`);
      resolved.push({ sessionId: s.id, title: s.title, branch: s.branch, prompt: t.prompt });
    }
    return this.bulk.propose(resolved, mode);
  }

  /** One summary per finished bulk run; its rows never relay one by one. */
  private relayBulkEnd(run: BulkRun): void {
    if (this.closing) return;
    const count = (s: BulkRowStatus) => run.rows.filter((r) => r.status === s).length;
    const lines = run.rows
      .filter((r) => r.status !== 'skipped')
      .map((r) => `- "${r.title}" (${r.sessionId}): ${r.status}${r.detail ? `: ${clip(r.detail, BULK_DETAIL_MAX)}` : ''}`);
    const head = `[bulk-end] run ${run.id}: ${count('done')} done, ${count('error')} error, ${count('skipped')} skipped.`;
    void this.orchestrator.send([head, ...lines].join('\n'), { origin: 'watch:bulk-end', mode: 'queue' });
  }

  private publish(event: RunnerEvent): void {
    for (const l of this.listeners) l(event);
  }
}
