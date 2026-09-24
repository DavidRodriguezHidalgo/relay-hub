import { app, BrowserWindow, dialog, Notification, shell } from 'electron';
import { repoFromPackage } from '@relay/engine';
import { readFileSync } from 'node:fs';
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

/** Version and repository from the app's own package.json; releases live there. */
function releasesFor(application: typeof app): { repo: string; currentVersion: string } | undefined {
  try {
    const pkg = JSON.parse(readFileSync(join(application.getAppPath(), 'package.json'), 'utf8')) as { repository?: unknown };
    const repo = repoFromPackage(pkg.repository);
    return repo ? { repo, currentVersion: application.getVersion() } : undefined;
  } catch {
    return undefined;
  }
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
    orchestratorDir: join(app.getPath('userData'), 'orchestrator'),
    updates: releasesFor(app),
  });
  engine.onError((err) => console.error('[relay] indexing problem:', err.message));
  registerEngineIpc(engine);
  engine.onEvent((event) => {
    if (event.type === 'approval') {
      new Notification({ title: 'Relay Hub: approval needed', body: event.approval.summary }).show();
    } else if (event.type === 'bulk' && event.run.status === 'finished') {
      const done = event.run.rows.filter((r) => r.status === 'done').length;
      const errors = event.run.rows.filter((r) => r.status === 'error').length;
      new Notification({ title: 'Relay Hub: bulk run finished', body: `${done} done, ${errors} error${errors === 1 ? '' : 's'}` }).show();
    } else if (event.type === 'pr-event') {
      const title = engine?.listSessions().find((s) => s.id === event.sessionId)?.title ?? event.sessionId;
      new Notification({ title: `Relay Hub: ${event.event.summary}`, body: title }).show();
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

// Interrupt driven sessions and wait for them before exiting, so transcripts stay resumable
// and no `claude` process is left orphaned mid-write.
let quitting = false;
let confirming = false;

/** Asks before quitting while sessions are mid-turn; quitting interrupts them. */
async function confirmQuit(active: { title: string; state: string }[]): Promise<boolean> {
  if (active.length === 0) return true;
  const { response } = await dialog.showMessageBox({
    type: 'warning',
    buttons: ['Quit', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    message: 'Sessions are still running',
    detail: `${active.map((s) => `• ${s.title} (${s.state})`).join('\n')}\n\nQuitting interrupts them.`,
  });
  return response === 0;
}

app.on('before-quit', (event) => {
  if (quitting || !engine) return;
  event.preventDefault();
  if (confirming) return;
  confirming = true;
  const current = engine;
  void confirmQuit(current.activeSessions()).then((ok) => {
    confirming = false;
    if (!ok) return;
    quitting = true;
    void current.close().finally(() => app.exit(0));
  });
});
