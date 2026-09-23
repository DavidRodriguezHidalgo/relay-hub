import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron';
import type { RelayEngine } from '@relay/engine';
import { IPC } from '@relay/shared';

/** Only our own windows' top frames may call the engine. */
function assertTrusted(event: IpcMainInvokeEvent): void {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || event.senderFrame !== event.sender.mainFrame) {
    throw new Error('IPC call from an untrusted frame');
  }
}

/** Wires one engine to IPC; returns a disposer. */
export function registerEngineIpc(engine: RelayEngine): () => void {
  ipcMain.handle(IPC.listSessions, (event) => {
    assertTrusted(event);
    return engine.listSessions();
  });
  ipcMain.handle(IPC.getTranscript, (event, id: string) => {
    assertTrusted(event);
    return engine.getTranscript(id);
  });
  const unsubscribe = engine.onSessionsChanged((sessions) => {
    for (const win of BrowserWindow.getAllWindows()) win.webContents.send(IPC.sessionsChanged, sessions);
  });
  return () => {
    unsubscribe();
    ipcMain.removeHandler(IPC.listSessions);
    ipcMain.removeHandler(IPC.getTranscript);
  };
}
