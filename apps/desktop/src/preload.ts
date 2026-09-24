import { contextBridge, ipcRenderer, webUtils } from 'electron';
import { IPC, type RelayApi, type RunnerEvent, type SessionSummary } from '@relay/shared';

function subscribe<T>(channel: string, listener: (payload: T) => void): () => void {
  const handler = (_e: unknown, payload: T) => listener(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.off(channel, handler);
}

const api: RelayApi = {
  listSessions: () => ipcRenderer.invoke(IPC.listSessions),
  getTranscript: (id) => ipcRenderer.invoke(IPC.getTranscript, id),
  onSessionsChanged: (listener) => subscribe<SessionSummary[]>(IPC.sessionsChanged, listener),
  send: (request) => ipcRenderer.invoke(IPC.send, request),
  interrupt: (sessionId) => ipcRenderer.invoke(IPC.interrupt, sessionId),
  decide: (approvalId, decision) => ipcRenderer.invoke(IPC.decide, approvalId, decision),
  runState: () => ipcRenderer.invoke(IPC.runState),
  onRunnerEvent: (listener) => subscribe<RunnerEvent>(IPC.runnerEvent, listener),
  orchestratorSend: (prompt) => ipcRenderer.invoke(IPC.orchestratorSend, prompt),
  orchestratorInterrupt: () => ipcRenderer.invoke(IPC.orchestratorInterrupt),
  orchestratorHistory: () => ipcRenderer.invoke(IPC.orchestratorHistory),
  bulkConfirm: (runId, sessionIds) => ipcRenderer.invoke(IPC.bulkConfirm, runId, sessionIds),
  bulkCancel: (runId) => ipcRenderer.invoke(IPC.bulkCancel, runId),
  watchCreate: (sessionId) => ipcRenderer.invoke(IPC.watchCreate, sessionId),
  watchDelete: (watchId) => ipcRenderer.invoke(IPC.watchDelete, watchId),
  listProjects: () => ipcRenderer.invoke(IPC.listProjects),
  createSession: (req) => ipcRenderer.invoke(IPC.createSession, req),
  listCommands: (sessionId) => ipcRenderer.invoke(IPC.listCommands, sessionId),
  takeOver: (sessionId) => ipcRenderer.invoke(IPC.takeOver, sessionId),
  settings: () => ipcRenderer.invoke(IPC.settings),
  setAllowAllActions: (on) => ipcRenderer.invoke(IPC.setAllowAllActions, on),
  channels: () => ipcRenderer.invoke(IPC.channels),
  aside: (sessionId, question) => ipcRenderer.invoke(IPC.aside, sessionId, question),
  // File.path is gone in current Electron; only the preload world can still resolve one
  pathForFile: (file) => webUtils.getPathForFile(file),
};

contextBridge.exposeInMainWorld('relay', api);
