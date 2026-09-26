import type { Invocable } from './commands';
import type { ApprovalDecision, DeliveryMode, MessageOrigin, PrWatch, RunState, RunnerEvent } from './runner';
import type { SessionSummary } from './session';
import type { Accomplished } from './accomplished';
import type { ModelChoice } from './models';
import type { SessionStatus } from './status';
import type { CheckoutPlan, CheckoutResult, UpdateCheck, UpdateMode } from './updates';
import type { TranscriptEntry } from './transcript';
import type { Todo, TodoDraft, TodoPatch } from './todo';
import type { Screenshot } from './shots';
import type { ContextUse } from './context';

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
  settings: 'relay:settings',
  setAllowAllActions: 'relay:setAllowAllActions',
  channels: 'relay:channels',
  aside: 'relay:aside',
  checkForUpdate: 'relay:checkForUpdate',
  listModels: 'relay:listModels',
  setModel: 'relay:setModel',
  sessionStatus: 'relay:sessionStatus',
  accomplished: 'relay:accomplished',
  downloadUpdate: 'relay:downloadUpdate',
  updateMode: 'relay:updateMode',
  checkoutPlan: 'relay:checkoutPlan',
  applyCheckout: 'relay:applyCheckout',
  listTodos: 'relay:listTodos',
  createTodo: 'relay:createTodo',
  updateTodo: 'relay:updateTodo',
  deleteTodo: 'relay:deleteTodo',
  launchTodo: 'relay:launchTodo',
  screenshots: 'relay:screenshots',
  attachTodo: 'relay:attachTodo',
  detachTodo: 'relay:detachTodo',
  contextUse: 'relay:contextUse',
  moveTodo: 'relay:moveTodo',
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
  settings(): Promise<{ allowAllActions: boolean }>;
  setAllowAllActions(on: boolean): Promise<void>;
  /** The channels the running main process answers; a window compares it with what it expects. */
  channels(): Promise<string[]>;
  /** A side question answered from a copy of the session; resolves with the answer. */
  aside(sessionId: string, question: string): Promise<string>;
  checkForUpdate(): Promise<UpdateCheck>;
  listModels(sessionId: string): Promise<ModelChoice[]>;
  setModel(sessionId: string, model: string): Promise<void>;
  sessionStatus(sessionId: string): Promise<SessionStatus>;
  accomplished(sessionId: string): Promise<Accomplished>;
  /** Fetches the published build and reveals it; resolves with where it landed. */
  downloadUpdate(url: string, name: string): Promise<string>;
  /** Whether this copy updates by replacing a build or by pulling a working copy. */
  updateMode(): Promise<UpdateMode>;
  checkoutPlan(): Promise<CheckoutPlan>;
  applyCheckout(): Promise<CheckoutResult>;
  listTodos(): Promise<Todo[]>;
  /** Each change answers with the whole list, so the window never has to guess the new order. */
  createTodo(draft: TodoDraft): Promise<Todo[]>;
  updateTodo(id: string, patch: TodoPatch): Promise<Todo[]>;
  deleteTodo(id: string): Promise<Todo[]>;
  /** Moves a todo a place up or down among the others in its half of the list. */
  moveTodo(id: string, direction: 'up' | 'down'): Promise<Todo[]>;
  /** Starts a session for this todo and joins the two. */
  launchTodo(id: string): Promise<{ sessionId: string; todos: Todo[] }>;
  /** Hands a todo to a session already open; says whether it was sent or queued. */
  attachTodo(id: string, sessionId: string): Promise<{ mode: DeliveryMode; todos: Todo[] }>;
  detachTodo(id: string): Promise<Todo[]>;
  /** How full this session’s context was at its last request; null if it never called the model. */
  contextUse(sessionId: string): Promise<ContextUse | null>;
  /** Images this session produced while working, newest first. */
  screenshots(sessionId: string): Promise<Screenshot[]>;
  /** The absolute path of a dropped file, which the renderer cannot read for itself. */
  pathForFile(file: File): string;
}
