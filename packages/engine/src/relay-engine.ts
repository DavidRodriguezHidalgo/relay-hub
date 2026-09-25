import { randomUUID } from 'node:crypto';
import { access, mkdir, realpath, stat } from 'node:fs/promises';
import { basename, isAbsolute, resolve } from 'node:path';
import { ORCHESTRATOR_KEY, type ApprovalDecision, type BulkRowStatus, type PrEvent, type PrWatch, type SessionState, type BulkRun, type DeliveryMode, type Invocable, type MessageOrigin, type RunnerEvent, type RunState, type SessionSummary, type TranscriptEntry, type UpdateCheck, type ModelChoice, type SessionStatus } from '@relay/shared';
import { ApprovalQueue } from './approvals/approval-queue';
import { BulkRuns, repairLoadedRuns } from './bulk/bulk-runs';
import { ExecGitInfoProvider, type GitInfoProvider } from './git/git-info';
import { workState, type WorkState } from './git/work-state';
import { SessionIndex } from './index/session-index';
import { Orchestrator } from './orchestrator/orchestrator';
import { createWorktree, repoRoot } from './git/worktrees';
import { ExecGhClient, repoFromPrUrl, type GhClient, type PrRef } from './pr/gh-client';
import { PrWatcher } from './pr/pr-watcher';
import { createRelayTools, type PrListing } from './orchestrator/relay-tools';
import type { AgentClient } from './runner/agent-client';
import { SdkAgentClient } from './runner/sdk-agent-client';
import { SessionBusyError } from './runner/session-busy-error';
import { ClaudeSessionRegistry, type SessionRegistry } from './runner/session-registry';
import { CommandCatalog } from './commands/command-catalog';
import { RELAY_COMMANDS } from './commands/relay-commands';
import { checkForUpdate, type UpdateSource } from './updates/update-check';
import { AsyncQueue } from './runner/async-queue';
import type { AgentInput } from './runner/agent-client';
import { SessionRunner, type TurnEnd } from './runner/session-runner';
import { SessionStore } from './store/session-store';

/** A transcript written more recently than this is assumed to have another writer. */
const BUSY_WINDOW_MS = 15_000;
/** Writes this soon after Relay's own run went idle are Relay's, not a terminal's. */
const OWN_WRITE_GRACE_MS = 1_000;
/** An idle runner (and its `claude` process) is closed after this long without a send. */
/** Meta key for the one setting the engine owns. */
const ALLOW_ALL_KEY = 'settings.allowAllActions';

/** Meta key holding the model a session was switched to. */
const modelKey = (sessionId: string) => `model.${sessionId}`;

const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60 * 1_000;
/** How much of a session's last reply the completion relay passes to the orchestrator. */
const RELAY_TEXT_MAX = 300;
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
  gh?: GhClient;
  prPollIntervalMs?: number;
  worktrees?: Worktrees;
  /** How often to look for sessions open in other Claude processes. */
  externalPollMs?: number;
  /** How long createSession waits for a new session to report its id. */
  createTimeoutMs?: number;
  /** Reads git facts about a directory; the real one shells out to git. */
  workState?: (cwd: string) => Promise<WorkState>;
  /** Where releases are published and what version this is; without it, checks report that. */
  updates?: UpdateSource;
}

/** Git operations createSession needs; injectable for tests. */
export interface Worktrees {
  repoRoot(cwd: string): Promise<string | null>;
  createWorktree(root: string, branch: string): Promise<string>;
}

export interface Project {
  name: string;
  root: string;
  sessions: number;
}

const DEFAULT_CREATE_TIMEOUT_MS = 60_000;
/** A new session's title until its transcript is indexed: its first prompt, shortened. */
const NEW_TITLE_MAX = 80;

export interface SendOptions {
  sessionId: string;
  prompt: string;
  mode: DeliveryMode;
  origin: MessageOrigin;
}

/** The single entry point the desktop app (and later a daemon) talks to. */
/** Settings the user controls, kept by Relay rather than by any one session. */
export interface RelaySettings {
  allowAllActions: boolean;
}

export class RelayEngine {
  private readonly runners = new Map<string, SessionRunner>();
  private readonly creating = new Map<string, Promise<SessionRunner>>();
  private readonly idleTimers = new Map<string, NodeJS.Timeout>();
  private readonly listeners = new Set<(e: RunnerEvent) => void>();
  private readonly orchestrator: Orchestrator;
  private readonly bulk: BulkRuns;
  private readonly watcher: PrWatcher;
  /** The orchestrator dir as given and with symlinks resolved (transcripts record the real path). */
  private readonly orchestratorCwds: Set<string>;
  private closing = false;
  private updates: UpdateSource | null = null;
  private readState: (cwd: string) => Promise<WorkState> = workState;
  private external: Record<string, 'busy' | 'idle'> = {};
  private readonly commands: CommandCatalog;
  private externalTimer: NodeJS.Timeout | null = null;

  private constructor(
    private readonly store: SessionStore,
    private readonly index: SessionIndex,
    private readonly agent: AgentClient,
    private readonly approvals: ApprovalQueue,
    private readonly now: () => Date,
    private readonly idleTimeoutMs: number,
    private readonly registry: SessionRegistry,
    orchestratorDir: string,
    orchestratorRealDir: string,
    loadedBulkRuns: BulkRun[],
    bulkConcurrency: number | undefined,
    private readonly gh: GhClient,
    prPollIntervalMs: number | undefined,
    private readonly worktrees: Worktrees,
    private readonly createTimeoutMs: number,
  ) {
    this.commands = new CommandCatalog(agent.describe?.bind(agent));
    this.approvals.setAllowAll(store.getMeta(ALLOW_ALL_KEY) === 'true');
    this.watcher = new PrWatcher({ gh, store, intervalMs: prPollIntervalMs });
    this.watcher.on('watch', (watch) => this.publish({ type: 'watch', watch, gh: this.watcher.ghStatus }));
    this.watcher.on('event', (watch, event) => this.onPrEvent(watch, event));
    this.watcher.on('removed', (watchId) => this.publish({ type: 'watch-removed', watchId, gh: this.watcher.ghStatus }));
    // a watch whose session is gone (deleted, or its worktree removed) can never wake anything
    index.on('changed', () => this.pruneWatches());
    this.bulk = new BulkRuns({ send: (req) => this.send(req), concurrency: bulkConcurrency }, loadedBulkRuns);
    this.bulk.on('changed', (run) => {
      this.store.saveBulkRun(run);
      this.publish({ type: 'bulk', run });
    });
    this.bulk.on('finished', (run) => this.relayBulkEnd(run));
    this.bulk.on('cancelled', (run) => {
      if (this.closing) return;
      void this.orchestrator.send(`[bulk-end] run ${run.id} was cancelled by the user; nothing ran.`, {
        origin: 'watch:bulk-end',
        mode: 'queue',
      });
    });
    this.orchestratorCwds = new Set([resolve(orchestratorDir), resolve(orchestratorRealDir)]);
    approvals.setMaxListeners(0); // every runner listens for its own approvals; they unsubscribe on close
    this.orchestrator = new Orchestrator({
      cwd: orchestratorRealDir,
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
        listPrs: () => this.listPrs(),
        createWatch: async (sessionId) => {
          this.refuseRelayOnly();
          return this.watchCreate(sessionId);
        },
        listProjects: () => this.listProjects(),
        createSession: async (req) => {
          this.refuseRelayOnly();
          return this.createSession({ ...req, origin: 'orchestrator' });
        },
        deleteWatch: async (sessionId) => {
          const w = this.watcher.forSession(sessionId);
          if (!w) throw new Error('Not watching a PR for that session');
          this.watchDelete(w.id);
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
    const orchestratorRealDir = await realpath(opts.orchestratorDir);
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
    const engine = new RelayEngine(
      store,
      index,
      opts.agent ?? new SdkAgentClient(),
      new ApprovalQueue(store),
      opts.now ?? (() => new Date()),
      opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS,
      opts.registry ?? new ClaudeSessionRegistry(),
      opts.orchestratorDir,
      orchestratorRealDir,
      loadedBulkRuns,
      opts.bulkConcurrency,
      opts.gh ?? new ExecGhClient(),
      opts.prPollIntervalMs,
      opts.worktrees ?? { repoRoot, createWorktree },
      opts.createTimeoutMs ?? DEFAULT_CREATE_TIMEOUT_MS,
    );
    engine.pruneWatches();
    engine.watcher.start();
    engine.updates = opts.updates ?? null;
    if (opts.workState) engine.readState = opts.workState;
    engine.watchExternal(opts.externalPollMs ?? 3_000);
    return engine;
  }

  /** Every session except the orchestrator's own, which must never be listed or targeted. */
  listSessions(): SessionSummary[] {
    return this.index.list().filter((s) => !this.orchestratorCwds.has(resolve(s.cwd)));
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

  /**
   * Stops whatever Claude process holds this session, so Relay can drive it, and returns the
   * pids stopped. The session itself is untouched: it is resumed from its transcript as usual.
   */
  async takeOver(sessionId: string): Promise<number[]> {
    const session = this.listSessions().find((x) => x.id === sessionId);
    if (!session) throw new Error(`Unknown session ${sessionId}`);
    const release = this.registry.release?.bind(this.registry);
    if (!release) throw new Error('Taking a session over is not available here');
    const pids = await release(sessionId);
    this.takenOverAt.set(sessionId, this.now().getTime());
    await this.refreshExternal();
    return pids;
  }

  /**
   * Answers a question about a session without touching it. The question runs against a fork of
   * the conversation as saved so far, kept off disk, so the session's own turn carries on and its
   * history never contains the aside. Both halves are shown under the session as a side thread.
   * Mid-turn, the fork knows the conversation only up to its last saved line.
   */
  async aside(sessionId: string, question: string): Promise<string> {
    const session = this.listSessions().find((s) => s.id === sessionId);
    if (!session) throw new Error(`Unknown session ${sessionId}`);
    const cwd = session.cwd;
    const input = new AsyncQueue<AgentInput>();
    const run = this.agent.start({
      sessionId,
      cwd,
      input,
      fork: true,
      persist: false,
      canUseTool: (toolName, args, blockedPath, signal) =>
        this.approvals.request({ sessionId, toolName, input: args, cwd, blockedPath, signal }),
      needsApproval: (toolName, args) => this.approvals.needsApproval({ sessionId, toolName, input: args, cwd }),
    });
    const asked = this.now().toISOString();
    this.publish({
      type: 'entry',
      sessionId,
      entry: { uuid: randomUUID(), role: 'user', timestamp: asked, isSidechain: false, isMeta: false, blocks: [{ kind: 'text', text: question }], origin: 'aside' },
    });
    input.push({ id: randomUUID(), text: question, priority: 'now', origin: 'aside' });
    let answer = '';
    try {
      for await (const m of run.messages) {
        if (m.type === 'init') continue; // the fork announcing its own id: nothing to show
        if (m.type === 'result') {
          if (m.isError) throw new Error(m.error ?? 'the side question failed');
          break;
        }
        this.publish({
          type: 'entry',
          sessionId,
          entry: { uuid: m.uuid, role: m.type === 'assistant' ? 'assistant' : 'user', timestamp: m.timestamp, isSidechain: m.sidechain, isMeta: false, blocks: m.blocks, origin: 'aside' },
        });
        if (m.type === 'assistant') {
          const text = m.blocks.flatMap((b) => (b.kind === 'text' ? [b.text] : [])).join('\n').trim();
          if (text) answer = text;
        }
      }
    } finally {
      input.end();
    }
    return answer;
  }

  /**
   * Where a session's work actually stands, read from git and the forge rather than narrated.
   *
   * Checks come from the pull request, which is the only place Relay can see whether the
   * typecheck, tests and end-to-end run passed. Without one there is nothing to report, and
   * `note` says so instead of leaving a blank that looks like a pass.
   */
  async sessionStatus(sessionId: string): Promise<SessionStatus> {
    const session = this.listSessions().find((s) => s.id === sessionId);
    if (!session) throw new Error(`Unknown session ${sessionId}`);
    const git = await this.readState(session.cwd);
    const base: SessionStatus = { ...git, pr: null, checks: null, note: null };

    const repo = session.prUrl?.match(/github\.com\/([^/]+\/[^/]+)\/pull\//)?.[1];
    if (!session.prNumber || !repo) {
      return { ...base, note: 'No pull request for this branch, so there are no checks to report.' };
    }
    try {
      const pr = await this.gh.viewPr(repo, session.prNumber);
      return {
        ...base,
        pr: { number: pr.number, url: pr.url, state: pr.state },
        checks: pr.checks.map((c) => ({ name: c.name, conclusion: c.conclusion ?? c.status ?? 'pending' })),
        note: pr.checks.length === 0 ? 'No checks have run on this pull request.' : null,
      };
    } catch (err) {
      return { ...base, note: `Could not ask GitHub: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  /** The models this session can run on, with the one it is on marked. */
  async listModels(sessionId: string): Promise<ModelChoice[]> {
    const session = this.listSessions().find((s) => s.id === sessionId);
    if (!session) throw new Error(`Unknown session ${sessionId}`);
    const { models } = await this.commands.list(session.cwd);
    const current = this.runners.get(sessionId)?.currentModel ?? this.store.getMeta(modelKey(sessionId));
    return models.map((m) => ({ ...m, current: current !== null && (m.id === current || m.name === current) }));
  }

  /** Switches a session to another model, now and for its later runs. */
  async setModel(sessionId: string, model: string): Promise<void> {
    const session = this.listSessions().find((s) => s.id === sessionId);
    if (!session) throw new Error(`Unknown session ${sessionId}`);
    this.store.setMeta(modelKey(sessionId), model);
    await this.runners.get(sessionId)?.setModel(model);
  }

  /** Whether a newer release exists than the one running. Never throws; failures come back in `error`. */
  checkForUpdate(): Promise<UpdateCheck> {
    if (!this.updates) {
      return Promise.resolve({ current: 'unknown', latest: null, newer: false, url: null, notes: null, publishedAt: null, error: 'this build does not know where its releases live' });
    }
    return checkForUpdate(this.updates);
  }

  /** What the user has turned on for themselves; kept across restarts. */
  settings(): RelaySettings {
    return { allowAllActions: this.store.getMeta(ALLOW_ALL_KEY) === 'true' };
  }

  /**
   * Lets sessions Relay drives act without asking. It covers Relay's own approvals only:
   * a session's own settings still apply, and take-over and bulk runs are still confirmed.
   */
  setAllowAllActions(on: boolean): void {
    this.store.setMeta(ALLOW_ALL_KEY, on ? 'true' : null);
    this.approvals.setAllowAll(on);
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

  /** Watches the session's PR: the one recorded in its transcript, else the open PR for its branch. */
  async watchCreate(sessionId: string): Promise<PrWatch> {
    const session = this.listSessions().find((s) => s.id === sessionId);
    if (!session) throw new Error(`Unknown session ${sessionId}`);
    let ref: PrRef | null = null;
    let closedRecorded: string | null = null;
    const recordedRepo = session.prUrl ? repoFromPrUrl(session.prUrl) : null;
    if (session.prUrl && session.prNumber !== null && recordedRepo) {
      // the transcript remembers the last PR it linked; it may be merged and the branch moved on
      const recorded = await this.gh.viewPr(recordedRepo, session.prNumber);
      if (recorded.state === 'OPEN') ref = { repo: recordedRepo, number: session.prNumber, url: session.prUrl };
      else closedRecorded = `PR #${session.prNumber} is ${recorded.state.toLowerCase()}`;
    }
    if (!ref && session.branch && session.cwdExists) {
      ref = await this.gh.findPrForBranch(session.cwd, session.branch);
    }
    if (!ref) {
      const branch = `branch ${session.branch ?? 'none'}`;
      throw new Error(
        closedRecorded
          ? `${closedRecorded} and there is no open pull request for session "${session.title}" (${branch})`
          : `No pull request found for session "${session.title}" (${branch})`,
      );
    }
    return this.watcher.add({ sessionId, repo: ref.repo, prNumber: ref.number, prUrl: ref.url });
  }

  /** What this session can be asked to run: its slash commands, skills and plugin commands. */
  async listCommands(sessionId: string): Promise<Invocable[]> {
    const session = this.listSessions().find((x) => x.id === sessionId);
    if (!session) throw new Error(`Unknown session ${sessionId}`);
    return [...RELAY_COMMANDS, ...(await this.commands.list(session.cwd)).commands];
  }

  watchDelete(watchId: string): void {
    this.watcher.remove(watchId);
  }

  /** Sessions with a turn in flight, for the quit confirmation. */
  activeSessions(): { id: string; title: string; state: SessionState }[] {
    const titles = new Map(this.listSessions().map((s) => [s.id, s.title]));
    return [...this.runners.entries()]
      .filter(([, r]) => r.state === 'running' || r.state === 'waiting-approval')
      .map(([id, r]) => ({ id, title: titles.get(id) ?? id, state: r.state }));
  }

  /** Main-repo roots of the sessions on this machine, with how many sessions each has. */
  async listProjects(): Promise<Project[]> {
    const cwds = [...new Set(this.listSessions().filter((s) => s.cwdExists).map((s) => s.cwd))];
    const counts = new Map<string, number>();
    const perCwd = new Map(this.listSessions().map((s) => [s.cwd, 0]));
    for (const s of this.listSessions()) perCwd.set(s.cwd, (perCwd.get(s.cwd) ?? 0) + 1);
    const roots = await Promise.all(cwds.map((cwd) => this.worktrees.repoRoot(cwd)));
    cwds.forEach((cwd, i) => {
      const root = roots[i];
      if (root) counts.set(root, (counts.get(root) ?? 0) + (perCwd.get(cwd) ?? 0));
    });
    return [...counts.entries()]
      .map(([root, sessions]) => ({ name: basename(root), root, sessions }))
      .sort((a, b) => a.name.localeCompare(b.name) || a.root.localeCompare(b.root));
  }

  /**
   * Starts a fresh Claude session: in a new worktree on `branch` when given, else in the project
   * directory itself. Resolves once the session reports its id.
   */
  async createSession(req: {
    project: string;
    branch?: string;
    prompt: string;
    origin: MessageOrigin;
  }): Promise<{ sessionId: string; cwd: string }> {
    const dir = await this.resolveProject(req.project);
    if (!req.branch) await this.refuseMainCheckout(dir);
    // a new branch gets a worktree of the main repo; without one the session runs exactly where asked
    const cwd = req.branch
      ? await this.worktrees.createWorktree((await this.worktrees.repoRoot(dir)) ?? dir, req.branch)
      : dir;
    const runner = new SessionRunner({
      sessionId: `new:${randomUUID()}`,
      resume: null,
      cwd,
      client: this.agent,
      approvals: this.approvals,
      profile: { kind: 'session' },
    });
    let sessionId: string;
    try {
      sessionId = await new Promise<string>((resolveId, reject) => {
        const done = (err: Error | null, id?: string) => {
          clearTimeout(timer);
          runner.off('session-id', onId);
          runner.off('state', onState);
          if (err) reject(err);
          else resolveId(id!);
        };
        const onId = (id: string) => done(null, id);
        const onState = (state: SessionState, error: string | null) => {
          if (state === 'error') done(new Error(error ?? 'unknown error'));
        };
        const timer = setTimeout(() => done(new Error('timed out waiting for the session to start')), this.createTimeoutMs);
        runner.on('session-id', onId);
        runner.on('state', onState);
        runner.send(req.prompt, { mode: 'steer', origin: req.origin }).catch((err: unknown) => done(err as Error));
      });
    } catch (err) {
      await runner.close();
      throw new Error(`Could not start a session in ${cwd}: ${err instanceof Error ? err.message : String(err)}`);
    }
    runner.rekey(sessionId);
    this.wire(runner, { id: sessionId, title: req.prompt.trim().slice(0, NEW_TITLE_MAX), branch: req.branch ?? null });
    this.publish({ type: 'state', sessionId, state: runner.state, error: runner.error });
    return { sessionId, cwd };
  }

  bulkConfirm(runId: string, sessionIds: string[]): void {
    this.bulk.confirm(runId, sessionIds);
  }

  bulkCancel(runId: string): void {
    this.bulk.cancel(runId);
  }

  /** Stops a session's current turn; false when it was not running. */
  async interrupt(sessionId: string): Promise<boolean> {
    if (!this.listSessions().some((s) => s.id === sessionId) && !this.runners.has(sessionId)) {
      throw new Error(`Unknown session ${sessionId}`);
    }
    const runner = this.runners.get(sessionId);
    if (!runner || runner.state === 'idle' || runner.state === 'error') return false;
    await runner.interrupt();
    return true;
  }

  decide(approvalId: string, decision: ApprovalDecision): void {
    this.approvals.decide(approvalId, decision);
  }

  runState(): RunState {
    const states: RunState['states'] = {};
    for (const [id, r] of this.runners) states[id] = { state: r.state, error: r.error };
    if (this.orchestrator.state !== 'idle' || this.orchestrator.error) {
      states[ORCHESTRATOR_KEY] = { state: this.orchestrator.state, error: this.orchestrator.error };
    }
    return { states, approvals: this.approvals.pending(), bulkRuns: this.bulk.recent(RECENT_BULK_RUNS),
      watches: this.watcher.list(),
      gh: this.watcher.ghStatus,
      external: this.external,
      queue: Object.fromEntries([...this.runners].map(([id, r]) => [id, r.queue])),
    };
  }

  async close(): Promise<void> {
    for (const t of this.idleTimers.values()) clearTimeout(t);
    this.idleTimers.clear();
    // Sessions first, with the relay off: their interrupted turns must not wake the orchestrator.
    this.closing = true;
    if (this.externalTimer) clearInterval(this.externalTimer);
    this.watcher.stop();
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
    const runner = new SessionRunner({
      sessionId,
      cwd: session.cwd,
      client: this.agent,
      approvals: this.approvals,
      model: this.store.getMeta(modelKey(sessionId)) ?? undefined,
    });
    this.wire(runner, session);
    return runner;
  }

  /** Registers a runner under its session id and connects it to events, bulk runs, the relay and the idle reaper. */
  private wire(runner: SessionRunner, session: Pick<SessionSummary, 'id' | 'title' | 'branch'>): void {
    const sessionId = session.id;
    runner.on('state', (state, error) => {
      this.publish({ type: 'state', sessionId, state, error });
      this.scheduleIdleClose(sessionId, state);
    });
    runner.on('entry', (entry) => this.publish({ type: 'entry', sessionId, entry }));
    runner.on('queue', (queue) => this.publish({ type: 'queue', sessionId, queue }));
    runner.on('turn-end', (end) => this.bulk.onTurnEnd(sessionId, end));
    runner.on('turn-end', (end) => this.relayTurnEnd(session, end));
    this.runners.set(sessionId, runner);
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
    const tookOver = this.takenOverAt.get(sessionId) ?? 0;
    if (recent && mtimeMs > ownWritesUntil && mtimeMs > tookOver) throw new SessionBusyError(sessionId);
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
  private relayTurnEnd(session: Pick<SessionSummary, 'id' | 'title' | 'branch'>, end: TurnEnd): void {
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

  /** A PR event is published; unless it is a merge, the session is woken with it as a queued message. */
  private onPrEvent(watch: PrWatch, event: PrEvent): void {
    this.publish({ type: 'pr-event', sessionId: watch.sessionId, watchId: watch.id, event });
    if (event.kind === 'merged' || this.closing) return;
    this.send({ sessionId: watch.sessionId, prompt: event.details, mode: 'queue', origin: `watch:${event.kind}` }).then(
      () => this.watcher.clearWakeError(watch.id),
      (err: unknown) => this.watcher.noteWakeError(watch.id, err instanceof Error ? err.message : String(err)),
    );
  }

  /** Polls Claude Code's process registry so sessions busy in a terminal show as running too. */
  /** When each session was last taken over; writes older than that were the stopped process's. */
  private readonly takenOverAt = new Map<string, number>();

  private async refreshExternal(): Promise<void> {
    const read = this.registry.openSessions?.bind(this.registry);
    if (!read) return;
    const next = await read().catch(() => this.external);
    if (JSON.stringify(next) === JSON.stringify(this.external)) return;
    this.external = next;
    this.publish({ type: 'external', external: next });
  }

  private watchExternal(intervalMs: number): void {
    if (!this.registry.openSessions) return;
    void this.refreshExternal();
    this.externalTimer = setInterval(() => void this.refreshExternal(), intervalMs);
    this.externalTimer.unref?.();
  }

  private pruneWatches(): void {
    const live = new Set(this.listSessions().filter((s) => s.cwdExists).map((s) => s.id));
    for (const w of this.watcher.list()) if (!live.has(w.sessionId)) this.watcher.remove(w.id);
  }

  private async listPrs(): Promise<PrListing[]> {
    const sessions = this.listSessions();
    const watches = this.watcher.list().filter((w) => w.active);
    return (await this.gh.listMyPrs()).map((p) => {
      // branch names repeat across repos: prefer the session in the PR's repo, and never guess between several
      const sameBranch = sessions.filter((s) => s.branch === p.headRefName);
      const repoName = p.repo.split('/')[1] ?? p.repo;
      const inRepo = sameBranch.filter((s) => s.repo === repoName);
      const candidates = inRepo.length > 0 ? inRepo : sameBranch;
      const session = candidates.length === 1 ? candidates[0]! : null;
      return {
        repo: p.repo,
        number: p.number,
        url: p.url,
        title: p.title,
        branch: p.headRefName,
        sessionId: session?.id ?? null,
        watched: watches.some((w) => w.repo === p.repo && w.prNumber === p.number),
      };
    });
  }

  /** The user works live in main clones: a session there would auto-accept edits under their feet. */
  private async refuseMainCheckout(dir: string): Promise<void> {
    const root = await this.worktrees.repoRoot(dir);
    const real = await realpath(dir).catch(() => dir);
    if (root && (resolve(root) === resolve(dir) || resolve(root) === resolve(real))) {
      throw new Error(
        `${dir} is the main checkout; give a new branch (a worktree will be created) or the path of an existing worktree`,
      );
    }
  }

  /** An existing absolute directory as given, or a project name that must match exactly one known repo root. */
  private async resolveProject(project: string): Promise<string> {
    if (isAbsolute(project)) {
      const found = await access(project).then(() => true, () => false);
      if (!found) throw new Error(`No such directory: ${project}`);
      return project;
    }
    const matches = (await this.listProjects()).filter((p) => p.name === project);
    if (matches.length === 0) throw new Error(`Unknown project ${project}`);
    if (matches.length > 1) {
      throw new Error(`Several projects are called ${project}: ${matches.map((m) => m.root).join(', ')}`);
    }
    return matches[0]!.root;
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
