import { app, BrowserWindow } from 'electron';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { RelayEngine } from '@relay/engine';
import { registerEngineIpc } from './ipc';

// MAIN_WINDOW_VITE_DEV_SERVER_URL and MAIN_WINDOW_VITE_NAME are declared by forge.env.d.ts.

let engine: RelayEngine | null = null;

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    titleBarStyle: 'hiddenInset',
    webPreferences: { preload: join(__dirname, 'preload.js') },
  });
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    void win.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    void win.loadFile(join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`));
  }
}

void app.whenReady().then(async () => {
  engine = await RelayEngine.start({
    projectsDir: process.env.RELAY_PROJECTS_DIR ?? join(homedir(), '.claude', 'projects'),
    dbPath: join(app.getPath('userData'), 'relay.db'),
  });
  registerEngineIpc(engine);
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  void engine?.close();
});
