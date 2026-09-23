import type { ApprovalDecision, DeliveryMode, MessageOrigin, RunState, RunnerEvent } from './runner';
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
}
