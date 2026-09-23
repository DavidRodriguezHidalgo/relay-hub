import { BrowserWindow, ipcMain } from 'electron';
import type { RelayEngine } from '@relay/engine';
import { IPC } from '@relay/shared';

/** Wires one engine to IPC; returns a disposer. */
export function registerEngineIpc(engine: RelayEngine): () => void {
  ipcMain.handle(IPC.listSessions, () => engine.listSessions());
  ipcMain.handle(IPC.getTranscript, (_e, id: string) => engine.getTranscript(id));
  const unsubscribe = engine.onSessionsChanged((sessions) => {
    for (const win of BrowserWindow.getAllWindows()) win.webContents.send(IPC.sessionsChanged, sessions);
  });
  return () => {
    unsubscribe();
    ipcMain.removeHandler(IPC.listSessions);
    ipcMain.removeHandler(IPC.getTranscript);
  };
}
