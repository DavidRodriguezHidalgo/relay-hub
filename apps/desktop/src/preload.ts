import { contextBridge, ipcRenderer } from 'electron';
import { IPC, type RelayApi, type SessionSummary } from '@relay/shared';

const api: RelayApi = {
  listSessions: () => ipcRenderer.invoke(IPC.listSessions),
  getTranscript: (id) => ipcRenderer.invoke(IPC.getTranscript, id),
  onSessionsChanged: (listener) => {
    const handler = (_e: unknown, sessions: SessionSummary[]) => listener(sessions);
    ipcRenderer.on(IPC.sessionsChanged, handler);
    return () => ipcRenderer.off(IPC.sessionsChanged, handler);
  },
};

contextBridge.exposeInMainWorld('relay', api);
