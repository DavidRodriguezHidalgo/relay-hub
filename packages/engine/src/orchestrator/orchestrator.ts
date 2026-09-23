import { EventEmitter } from 'node:events';
import {
  ORCHESTRATOR_KEY,
  type DeliveryMode,
  type LiveEntry,
  type MessageOrigin,
  type SessionState,
} from '@relay/shared';
import type { ApprovalQueue } from '../approvals/approval-queue';
import type { AgentClient, AgentTool } from '../runner/agent-client';
import { SessionRunner } from '../runner/session-runner';
import type { SessionStore } from '../store/session-store';
import { ORCHESTRATOR_SYSTEM_PROMPT } from './system-prompt';

const SESSION_ID_KEY = 'orchestrator.sessionId';

export interface OrchestratorOptions {
  cwd: string;
  client: AgentClient;
  approvals: ApprovalQueue;
  store: SessionStore;
  tools: AgentTool[];
}

type OrchestratorEvents = { state: [SessionState, string | null]; entry: [LiveEntry] };

/** The chat agent in the middle column: a runner with Relay's tools and a remembered session. */
export class Orchestrator extends EventEmitter<OrchestratorEvents> {
  private readonly runner: SessionRunner;
  private readonly store: SessionStore;
  /** A stored id not yet proven resumable; an `init` for it proves it (a dead resume fails before init). */
  private unconfirmed: string | null;

  constructor(opts: OrchestratorOptions) {
    super();
    this.store = opts.store;
    this.unconfirmed = opts.store.getMeta(SESSION_ID_KEY);
    this.runner = new SessionRunner({
      sessionId: ORCHESTRATOR_KEY,
      resume: this.unconfirmed,
      cwd: opts.cwd,
      client: opts.client,
      approvals: opts.approvals,
      profile: { kind: 'orchestrator', systemPrompt: ORCHESTRATOR_SYSTEM_PROMPT, tools: opts.tools },
    });
    this.runner.on('session-id', (id) => {
      this.unconfirmed = null;
      if (this.store.getMeta(SESSION_ID_KEY) !== id) this.store.setMeta(SESSION_ID_KEY, id);
    });
    this.runner.on('state', (s, e) => this.emit('state', s, e));
    this.runner.on('entry', (e) => this.emit('entry', e));
    this.runner.on('turn-end', ({ error }) => {
      if (!error) return;
      // A resume of a transcript that no longer exists fails every time; start over instead.
      if (this.unconfirmed && this.runner.resumeSessionId === this.unconfirmed) {
        this.store.setMeta(SESSION_ID_KEY, null);
        this.runner.resetSession();
        this.unconfirmed = null;
      }
    });
  }

  get sessionId(): string | null {
    return this.runner.resumeSessionId;
  }

  get state(): SessionState {
    return this.runner.state;
  }

  get error(): string | null {
    return this.runner.error;
  }

  /** True when every pending message was fed by Relay (a turn-end), none by the user. */
  get onlyRelayPending(): boolean {
    const origins = this.runner.outstandingOrigins;
    return origins.length > 0 && origins.every((o) => o.startsWith('watch:'));
  }

  send(prompt: string, opts: { origin?: MessageOrigin; mode?: DeliveryMode } = {}): Promise<string> {
    return this.runner.send(prompt, { mode: opts.mode ?? 'steer', origin: opts.origin ?? 'user' });
  }

  interrupt(): Promise<void> {
    return this.runner.interrupt();
  }

  close(): Promise<void> {
    return this.runner.close();
  }
}
