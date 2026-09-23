import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { GhStatus, PrEvent, PrWatch } from '@relay/shared';
import type { SessionStore } from '../store/session-store';
import type { GhClient } from './gh-client';
import { diffSnapshots, toSnapshot, type PrSnapshot } from './snapshot';

export const PR_POLL_INTERVAL_MS = 300_000;

export interface PrWatcherOptions { gh: GhClient; store: SessionStore; intervalMs?: number; now?: () => Date }

type WatcherEvents = { watch: [PrWatch]; event: [PrWatch, PrEvent]; gh: [GhStatus] };
type Entry = { watch: PrWatch; snapshot: PrSnapshot | null };

/** Polls `gh` for each watched PR, diffs against the last snapshot, and emits what changed. */
export class PrWatcher extends EventEmitter<WatcherEvents> {
  private readonly entries = new Map<string, Entry>();
  private readonly gh: GhClient;
  private readonly store: SessionStore;
  private readonly intervalMs: number;
  private readonly now: () => Date;
  private viewer: string | null = null;
  private status: GhStatus = { state: 'ok' };
  private timer: NodeJS.Timeout | null = null;
  private pass: Promise<void> | null = null;

  constructor(opts: PrWatcherOptions) {
    super();
    this.gh = opts.gh;
    this.store = opts.store;
    this.intervalMs = opts.intervalMs ?? PR_POLL_INTERVAL_MS;
    this.now = opts.now ?? (() => new Date());
    for (const e of opts.store.loadWatches()) this.entries.set(e.watch.id, { watch: e.watch, snapshot: e.snapshot });
  }

  get ghStatus(): GhStatus { return this.status; }

  list(): PrWatch[] { return [...this.entries.values()].map((e) => ({ ...e.watch })); }

  forSession(sessionId: string): PrWatch | null {
    const e = [...this.entries.values()].find((x) => x.watch.sessionId === sessionId && x.watch.active);
    return e ? { ...e.watch } : null;
  }

  async add(ref: { sessionId: string; repo: string; prNumber: number; prUrl: string }): Promise<PrWatch> {
    if (this.forSession(ref.sessionId)) throw new Error(`Already watching a PR for session ${ref.sessionId}`);
    const entry: Entry = {
      watch: { id: randomUUID(), ...ref, active: true, createdAt: this.now().toISOString(), lastPolledAt: null, lastError: null },
      snapshot: null,
    };
    this.entries.set(entry.watch.id, entry);
    await this.poll(entry);
    return { ...entry.watch };
  }

  remove(watchId: string): void {
    this.entries.delete(watchId);
    this.store.deleteWatch(watchId);
  }

  pollAll(): Promise<void> {
    this.pass ??= (async () => {
      try {
        for (const e of this.entries.values()) if (e.watch.active) await this.poll(e);
      } finally {
        this.pass = null;
      }
    })();
    return this.pass;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.pollAll(), this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async poll(entry: Entry): Promise<void> {
    const w = entry.watch;
    try {
      this.viewer ??= await this.gh.viewer();
      const pr = await this.gh.viewPr(w.repo, w.prNumber);
      const next = toSnapshot(pr);
      const events = entry.snapshot ? diffSnapshots(entry.snapshot, next, pr, this.viewer) : [];
      entry.snapshot = next;
      w.lastPolledAt = this.now().toISOString();
      w.lastError = null;
      if (pr.state !== 'OPEN') w.active = false;
      this.setStatus({ state: 'ok' });
      this.save(entry);
      for (const e of events) this.emit('event', { ...w }, e);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      w.lastError = message;
      this.setStatus({ state: 'unavailable', message });
      this.save(entry);
    }
  }

  private save(entry: Entry): void {
    this.store.saveWatch(entry.watch, entry.snapshot);
    this.emit('watch', { ...entry.watch });
  }

  private setStatus(next: GhStatus): void {
    const same = next.state === this.status.state && (next.state === 'ok' || (this.status.state === 'unavailable' && this.status.message === next.message));
    this.status = next;
    if (!same) this.emit('gh', next);
  }
}
