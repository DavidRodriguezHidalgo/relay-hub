import type { Invocable } from './commands';
import type { ApprovalDecision, DeliveryMode, MessageOrigin, PrWatch, RunState, RunnerEvent } from './runner';
import type { SessionSummary } from './session';
import type { TranscriptEntry } from './transcript';

export const IPC = {
  listSessions: 'relay:listSessions',
  getTranscript: 'relay:getTranscript',
  sessionsChanged: 'relay:sessionsChanged',
  send: 'relay:send',
  interrupt: 'relay:interrupt',
  decide: 'relay:decide',
  runState: 'relay:runState',
  runnerEvent: 'relay:runnerEvent',
  orchestratorSend: 'relay:orchestratorSend',
  orchestratorInterrupt: 'relay:orchestratorInterrupt',
  orchestratorHistory: 'relay:orchestratorHistory',
  bulkConfirm: 'relay:bulkConfirm',
  bulkCancel: 'relay:bulkCancel',
  watchCreate: 'relay:watchCreate',
  watchDelete: 'relay:watchDelete',
  listProjects: 'relay:listProjects',
  createSession: 'relay:createSession',
  listCommands: 'relay:listCommands',
  takeOver: 'relay:takeOver',
} as const;

export interface SendRequest {
  sessionId: string;
  prompt: string;
  mode: DeliveryMode;
  origin: MessageOrigin;
}

/** What the renderer sees on `window.relay`. */
export interface RelayApi {
  listSessions(): Promise<SessionSummary[]>;
  getTranscript(id: string): Promise<TranscriptEntry[]>;
  onSessionsChanged(listener: (sessions: SessionSummary[]) => void): () => void;
  send(request: SendRequest): Promise<string>;
  interrupt(sessionId: string): Promise<void>;
  decide(approvalId: string, decision: ApprovalDecision): Promise<void>;
  runState(): Promise<RunState>;
  onRunnerEvent(listener: (event: RunnerEvent) => void): () => void;
  orchestratorSend(prompt: string): Promise<string>;
  orchestratorInterrupt(): Promise<void>;
  orchestratorHistory(): Promise<TranscriptEntry[]>;
  bulkConfirm(runId: string, sessionIds: string[]): Promise<void>;
  bulkCancel(runId: string): Promise<void>;
  watchCreate(sessionId: string): Promise<PrWatch>;
  watchDelete(watchId: string): Promise<void>;
  listProjects(): Promise<{ name: string; root: string; sessions: number }[]>;
  createSession(req: { project: string; branch: string; prompt: string }): Promise<{ sessionId: string; cwd: string }>;
  listCommands(sessionId: string): Promise<Invocable[]>;
  takeOver(sessionId: string): Promise<number[]>;
  /** The absolute path of a dropped file, which the renderer cannot read for itself. */
  pathForFile(file: File): string;
}
