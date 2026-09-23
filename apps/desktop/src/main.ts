import { app, BrowserWindow, dialog, Notification, shell } from 'electron';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { RelayEngine } from '@relay/engine';
import { registerEngineIpc } from './ipc';

// MAIN_WINDOW_VITE_DEV_SERVER_URL and MAIN_WINDOW_VITE_NAME are declared by forge.env.d.ts.

let engine: RelayEngine | null = null;

/** Links leave the app through the system browser; the renderer never navigates away. */
function keepNavigationInside(win: BrowserWindow): void {
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (url !== win.webContents.getURL()) {
      event.preventDefault();
      void shell.openExternal(url);
    }
  });
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    titleBarStyle: 'hiddenInset',
    webPreferences: { preload: join(__dirname, 'preload.js') },
  });
  keepNavigationInside(win);
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    void win.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    void win.loadFile(join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`));
  }
}

async function start(): Promise<void> {
  engine = await RelayEngine.start({
    projectsDir: process.env.RELAY_PROJECTS_DIR ?? join(homedir(), '.claude', 'projects'),
    dbPath: join(app.getPath('userData'), 'relay.db'),
  });
  engine.onError((err) => console.error('[relay] indexing problem:', err.message));
  registerEngineIpc(engine);
  engine.onEvent((event) => {
    if (event.type === 'approval') {
      new Notification({ title: 'Relay Hub: approval needed', body: event.approval.summary }).show();
    } else if (event.type === 'state' && event.state === 'error') {
      new Notification({ title: 'Relay Hub: session error', body: event.error ?? 'unknown error' }).show();
    }
  });
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}

void app.whenReady().then(() =>
  start().catch((err: unknown) => {
    dialog.showErrorBox('Relay Hub could not start', err instanceof Error ? err.message : String(err));
    app.quit();
  }),
);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  void engine?.close();
});
