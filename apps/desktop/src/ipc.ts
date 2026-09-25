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
  /** Everything a window may invoke. A dev window hot-reloads; the process behind it does not. */
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
    IPC.listCommands,
    IPC.takeOver,
    IPC.settings,
    IPC.setAllowAllActions,
    IPC.channels,
    IPC.aside,
    IPC.checkForUpdate,
    IPC.listModels,
    IPC.setModel,
    IPC.sessionStatus,
  ];
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
  handle(IPC.listCommands, (sessionId: string) => engine.listCommands(sessionId));
  handle(IPC.takeOver, (sessionId: string) => engine.takeOver(sessionId));
  handle(IPC.settings, () => engine.settings());
  handle(IPC.setAllowAllActions, (on: boolean) => engine.setAllowAllActions(on));
  handle(IPC.channels, () => channels);
  handle(IPC.aside, (sessionId: string, question: string) => engine.aside(sessionId, question));
  handle(IPC.checkForUpdate, () => engine.checkForUpdate());
  handle(IPC.listModels, (sessionId: string) => engine.listModels(sessionId));
  handle(IPC.setModel, (sessionId: string, model: string) => engine.setModel(sessionId, model));
  handle(IPC.sessionStatus, (sessionId: string) => engine.sessionStatus(sessionId));
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

  return () => {
    for (const u of unsubs) u();
    for (const c of channels) ipcMain.removeHandler(c);
  };
}
