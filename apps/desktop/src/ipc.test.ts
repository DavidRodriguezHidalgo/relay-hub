// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { IPC, MAIN_CHANNELS } from '@relay/shared';
import type { RelayEngine } from '@relay/engine';

const handled: string[] = [];
const removed: string[] = [];
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string) => handled.push(channel),
    removeHandler: (channel: string) => removed.push(channel),
  },
  BrowserWindow: { fromWebContents: () => null, getAllWindows: () => [] },
}));

const { registerEngineIpc } = await import('./ipc');

/** Channels the preload actually invokes, read from its source so this cannot drift. */
const preload = readFileSync(fileURLToPath(new URL('./preload.ts', import.meta.url)), 'utf8');
const invoked = [...preload.matchAll(/ipcRenderer\.invoke\(IPC\.(\w+)/g)].map((m) => IPC[m[1] as keyof typeof IPC]);

/** Broadcast from main to the window; nobody invokes these. */
const BROADCAST = new Set<string>([IPC.sessionsChanged, IPC.runnerEvent]);

/** Handled in main.ts rather than by the engine: it needs the filesystem and Finder. */
const IN_MAIN = new Set<string>(MAIN_CHANNELS);

describe('engine IPC', () => {
  const engine = { onSessionsChanged: () => () => undefined, onEvent: () => () => undefined } as unknown as RelayEngine;
  const dispose = registerEngineIpc(engine);

  it('registers a handler for every channel the preload invokes', () => {
    expect(invoked.length).toBeGreaterThan(10);
    for (const channel of invoked) {
      if (IN_MAIN.has(channel)) continue;
      expect(handled, `no handler for ${channel}`).toContain(channel);
    }
  });

  it('registers a handler for every invokable channel that exists at all', () => {
    for (const channel of Object.values(IPC)) {
      if (!BROADCAST.has(channel) && !IN_MAIN.has(channel)) expect(handled, `no handler for ${channel}`).toContain(channel);
    }
  });

  it('removes exactly what it registered', () => {
    dispose();
    expect([...removed].sort()).toEqual([...handled].sort());
  });
});


describe('what the window is told the process answers', () => {
  it('leaves no channel unaccounted for, so a complete process is never read as out of date', () => {
    // the window compares every channel it knows against this; anything missing reads as stale
    const answered = new Set<string>([...handled, ...MAIN_CHANNELS]);
    const unaccounted = Object.values(IPC).filter((c) => !BROADCAST.has(c) && !answered.has(c));
    expect(unaccounted).toEqual([]);
  });

  it('names the app-owned channels rather than leaving them to a hand-kept list', () => {
    expect([...MAIN_CHANNELS]).toContain(IPC.checkoutPlan);
    expect([...MAIN_CHANNELS]).toContain(IPC.crashReports);
  });
});
