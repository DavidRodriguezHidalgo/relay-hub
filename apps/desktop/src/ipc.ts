import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron';
import type { RelayEngine } from '@relay/engine';
import { IPC, type ApprovalDecision, type SendRequest } from '@relay/shared';

/** Only our own windows' top frames may call the engine. */
function assertTrusted(event: IpcMainInvokeEvent): void {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || event.senderFrame !== event.sender.mainFrame) {
    throw new Error('IPC call from an untrusted frame');
  }
}

/** Wires one engine to IPC; returns a disposer. */
export function registerEngineIpc(engine: RelayEngine): () => void {
  const handle = (channel: string, fn: (...args: never[]) => unknown) => {
    ipcMain.handle(channel, (event, ...args) => {
      assertTrusted(event);
      return fn(...(args as never[]));
    });
  };
  handle(IPC.listSessions, () => engine.listSessions());
  handle(IPC.getTranscript, (id: string) => engine.getTranscript(id));
  handle(IPC.send, (req: SendRequest) => engine.send(req));
  handle(IPC.interrupt, (id: string) => engine.interrupt(id));
  handle(IPC.decide, (id: string, decision: ApprovalDecision) => engine.decide(id, decision));
  handle(IPC.runState, () => engine.runState());
  handle(IPC.orchestratorSend, (prompt: string) => engine.orchestratorSend(prompt));
  handle(IPC.orchestratorInterrupt, () => engine.orchestratorInterrupt());
  handle(IPC.orchestratorHistory, () => engine.orchestratorHistory());
  handle(IPC.bulkConfirm, (runId: string, sessionIds: string[]) => engine.bulkConfirm(runId, sessionIds));
  handle(IPC.bulkCancel, (runId: string) => engine.bulkCancel(runId));
  handle(IPC.watchCreate, (sessionId: string) => engine.watchCreate(sessionId));
  handle(IPC.watchDelete, (watchId: string) => engine.watchDelete(watchId));
  handle(IPC.listProjects, () => engine.listProjects());
  handle(IPC.createSession, (req: { project: string; branch: string; prompt: string }) =>
    engine.createSession({ ...req, origin: 'user' }),
  );

  const broadcast = (channel: string, payload: unknown) => {
    for (const win of BrowserWindow.getAllWindows()) win.webContents.send(channel, payload);
  };
  const unsubs = [
    engine.onSessionsChanged((sessions) => broadcast(IPC.sessionsChanged, sessions)),
    engine.onEvent((event) => broadcast(IPC.runnerEvent, event)),
  ];
  const channels = [
    IPC.listSessions,
    IPC.getTranscript,
    IPC.send,
    IPC.interrupt,
    IPC.decide,
    IPC.runState,
    IPC.orchestratorSend,
    IPC.orchestratorInterrupt,
    IPC.orchestratorHistory,
    IPC.bulkConfirm,
    IPC.bulkCancel,
    IPC.watchCreate,
    IPC.watchDelete,
    IPC.listProjects,
    IPC.createSession,
  ];
  return () => {
    for (const u of unsubs) u();
    for (const c of channels) ipcMain.removeHandler(c);
  };
}
