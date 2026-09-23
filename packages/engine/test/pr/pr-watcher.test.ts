import { describe, expect, it } from 'vitest';
import type { GhStatus, PrEvent, PrWatch } from '@relay/shared';
import type { GhClient, PrData } from '../../src/pr/gh-client';
import { PrWatcher } from '../../src/pr/pr-watcher';
import { SessionStore } from '../../src/store/session-store';

const pr = (over: Partial<PrData> = {}): PrData => ({
  number: 7, url: 'https://github.com/o/r/pull/7', title: 'M', state: 'OPEN', headRefName: 'feat/m', headRefOid: 'h1',
  baseRefName: 'main', mergeable: 'MERGEABLE', mergeStateStatus: 'BLOCKED', checks: [], feedback: [], ...over,
});

class FakeGh implements GhClient {
  data: PrData = pr();
  fail: string | null = null;
  /** Per PR number: a failure only that PR hits (404, lost access). */
  failFor: Record<number, string> = {};
  gate: Promise<void> | null = null;
  views = 0;
  async viewer() { if (this.fail) throw new Error(this.fail); return 'me'; }
  async viewPr(_repo: string, n: number) {
    this.views += 1;
    if (this.gate) await this.gate;
    if (this.fail) throw new Error(this.fail);
    if (this.failFor[n]) throw new Error(this.failFor[n]);
    return { ...this.data, number: n };
  }
  async findPrForBranch() { return null; }
  async listMyPrs() { return []; }
}

function setup(store = new SessionStore(':memory:')) {
  const gh = new FakeGh();
  const w = new PrWatcher({ gh, store, now: () => new Date('2026-09-23T12:00:00.000Z') });
  const events: [PrWatch, PrEvent][] = [];
  const statuses: GhStatus[] = [];
  w.on('event', (watch, e) => events.push([watch, e]));
  w.on('gh', (s) => statuses.push(s));
  return { gh, w, events, statuses, store };
}
const ref = { sessionId: 's1', repo: 'o/r', prNumber: 7, prUrl: 'https://github.com/o/r/pull/7' };
const failing = [{ name: 'test', conclusion: 'FAILURE', status: 'COMPLETED' }];

describe('PrWatcher', () => {
  it('add baselines without events; a later change produces one event per poll change', async () => {
    const { gh, w, events } = setup();
    const watch = await w.add(ref);
    expect(watch).toMatchObject({ sessionId: 's1', active: true, lastPolledAt: '2026-09-23T12:00:00.000Z', lastError: null });
    expect(events).toEqual([]);
    gh.data = pr({ checks: failing });
    await w.pollAll();
    await w.pollAll();
    expect(events.map(([, e]) => e.kind)).toEqual(['ci_failed']);
  });

  it('refuses a second active watch for the same session', async () => {
    const { w } = setup();
    await w.add(ref);
    await expect(w.add(ref)).rejects.toThrow(/already watching/i);
  });

  it('a failed poll records the error, reports gh unavailable, keeps the snapshot and produces no events', async () => {
    const { gh, w, events, statuses } = setup();
    await w.add(ref);
    gh.fail = 'gh: not logged in';
    gh.data = pr({ checks: failing });
    await w.pollAll();
    expect(w.list()[0]!.lastError).toBe('gh: not logged in');
    expect(w.ghStatus).toEqual({ state: 'unavailable', message: 'gh: not logged in' });
    expect(events).toEqual([]);
    gh.fail = null;
    await w.pollAll();
    expect(w.ghStatus).toEqual({ state: 'ok' });
    expect(events.map(([, e]) => e.kind)).toEqual(['ci_failed']); // diffed against the kept pre-failure snapshot
    expect(statuses).toEqual([{ state: 'unavailable', message: 'gh: not logged in' }, { state: 'ok' }]);
  });

  it('a merged PR emits merged once and deactivates the watch', async () => {
    const { gh, w, events } = setup();
    await w.add(ref);
    gh.data = pr({ state: 'MERGED' });
    await w.pollAll();
    await w.pollAll();
    expect(events.map(([, e]) => e.kind)).toEqual(['merged']);
    expect(w.list()[0]!.active).toBe(false);
    expect(w.forSession('s1')).toBeNull();
  });

  it('a closed-not-merged PR deactivates the watch without an event', async () => {
    const { gh, w, events } = setup();
    await w.add(ref);
    gh.data = pr({ state: 'CLOSED' });
    await w.pollAll();
    expect(events).toEqual([]);
    expect(w.list()[0]!.active).toBe(false);
  });

  it('persists watches and snapshots across restarts', async () => {
    const store = new SessionStore(':memory:');
    const first = setup(store);
    await first.w.add(ref);
    const second = setup(store);
    expect(second.w.list().map((x) => x.sessionId)).toEqual(['s1']);
    second.gh.data = pr({ checks: failing });
    await second.w.pollAll();
    expect(second.events.map(([, e]) => e.kind)).toEqual(['ci_failed']); // no second baseline
  });

  it('remove deletes the watch', async () => {
    const { w, store } = setup();
    const watch = await w.add(ref);
    w.remove(watch.id);
    expect(w.list()).toEqual([]);
    expect(store.loadWatches()).toEqual([]);
  });

  it('overlapping pollAll calls share one pass', async () => {
    const { gh, w } = setup();
    await w.add(ref);
    gh.views = 0;
    await Promise.all([w.pollAll(), w.pollAll()]);
    expect(gh.views).toBe(1);
  });

  it('remove announces the removal so the UI can drop it', async () => {
    const { w } = setup();
    const removed: string[] = [];
    w.on('removed', (id) => removed.push(id));
    const watch = await w.add(ref);
    w.remove(watch.id);
    expect(removed).toEqual([watch.id]);
  });

  it("one broken watch does not mark gh unavailable while others work", async () => {
    const { gh, w } = setup();
    await w.add(ref);
    await w.add({ ...ref, sessionId: "s2", prNumber: 8 });
    gh.failFor[8] = "HTTP 404: Not Found";
    await w.pollAll();
    expect(w.ghStatus).toEqual({ state: "ok" });
    expect(w.list().find((x) => x.prNumber === 8)!.lastError).toBe("HTTP 404: Not Found");
  });

  it("removing the only failing watch clears the unavailable status", async () => {
    const { gh, w, statuses } = setup();
    const watch = await w.add(ref);
    gh.fail = "gh: not logged in";
    await w.pollAll();
    expect(w.ghStatus.state).toBe("unavailable");
    w.remove(watch.id);
    expect(w.ghStatus).toEqual({ state: "ok" });
    expect(statuses.at(-1)).toEqual({ state: "ok" });
  });

  it("a watch deleted while its poll is in flight stays deleted", async () => {
    const { gh, w, store } = setup();
    const watch = await w.add(ref);
    let release!: () => void;
    gh.gate = new Promise((r) => (release = r));
    const pass = w.pollAll();
    await new Promise((r) => setTimeout(r, 5));
    w.remove(watch.id);
    release();
    await pass;
    expect(w.list()).toEqual([]);
    expect(store.loadWatches()).toEqual([]);
  });

  it("a refused wake stays visible after the next good poll", async () => {
    const { w } = setup();
    const watch = await w.add(ref);
    w.noteWakeError(watch.id, "Session s1 is open in another Claude process (pid 7)");
    await w.pollAll();
    expect(w.list()[0]!.wakeError).toBe("Session s1 is open in another Claude process (pid 7)");
    w.clearWakeError(watch.id);
    expect(w.list()[0]!.wakeError).toBeNull();
  });

  it("start() polls right away instead of waiting a whole interval", async () => {
    const { gh, w } = setup();
    await w.add(ref);
    gh.views = 0;
    w.start();
    await new Promise((r) => setTimeout(r, 20));
    w.stop();
    expect(gh.views).toBe(1);
  });

  it("a pass with no watches does not block later passes", async () => {
    const { gh, w } = setup();
    await w.pollAll(); // nothing to poll: finishes at once
    await w.add(ref);
    gh.views = 0;
    await w.pollAll();
    expect(gh.views).toBe(1);
  });
});
