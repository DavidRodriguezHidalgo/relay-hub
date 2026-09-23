import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { BulkRow, BulkRun, DeliveryMode, MessageOrigin } from '@relay/shared';
import type { TurnEnd } from '../runner/session-runner';

export const BULK_CONCURRENCY = 3;
const CLOSED_MID_RUN = 'Relay was closed during the run';

export const bulkOrigin = (runId: string): MessageOrigin => `bulk:${runId}`;

export interface BulkTarget {
  sessionId: string;
  title: string;
  branch: string | null;
  prompt: string;
}

export interface BulkRunsDeps {
  send(req: { sessionId: string; prompt: string; mode: DeliveryMode; origin: MessageOrigin }): Promise<string>;
  now?: () => Date;
  concurrency?: number;
}

type BulkEvents = { changed: [BulkRun]; finished: [BulkRun] };

const copy = (run: BulkRun): BulkRun => ({ ...run, rows: run.rows.map((r) => ({ ...r })) });
const settled = (r: BulkRow) => r.status === 'done' || r.status === 'error' || r.status === 'skipped';

/** Runs loaded after a restart: nothing is still running, and nothing waits for a confirm nobody can give. */
export function repairLoadedRuns(runs: BulkRun[]): BulkRun[] {
  return runs.map((run) => {
    if (run.status === 'proposed') return { ...copy(run), status: 'cancelled' };
    if (run.status !== 'running') return copy(run);
    return {
      ...run,
      status: 'finished',
      rows: run.rows.map((r) => (settled(r) ? { ...r } : { ...r, status: 'error', detail: CLOSED_MID_RUN })),
    };
  });
}

/** One instruction for many sessions: proposed, confirmed by the user, then run a few at a time. */
export class BulkRuns extends EventEmitter<BulkEvents> {
  private readonly runs = new Map<string, BulkRun>();
  private readonly now: () => Date;
  private readonly concurrency: number;

  constructor(
    private readonly deps: BulkRunsDeps,
    initial: BulkRun[] = [],
  ) {
    super();
    this.now = deps.now ?? (() => new Date());
    this.concurrency = deps.concurrency ?? BULK_CONCURRENCY;
    for (const run of initial) this.runs.set(run.id, copy(run));
  }

  propose(targets: BulkTarget[], mode: DeliveryMode): BulkRun {
    const run: BulkRun = {
      id: randomUUID(),
      createdAt: this.now().toISOString(),
      mode,
      status: 'proposed',
      rows: targets.map((t) => ({ ...t, status: 'proposed', detail: null })),
    };
    this.runs.set(run.id, run);
    this.changed(run);
    return copy(run);
  }

  confirm(runId: string, sessionIds: string[]): void {
    const run = this.proposed(runId);
    const picked = new Set(sessionIds);
    for (const row of run.rows) row.status = picked.has(row.sessionId) ? 'queued' : 'skipped';
    run.status = run.rows.some((r) => r.status === 'queued') ? 'running' : 'cancelled';
    this.changed(run);
    if (run.status === 'running') this.pump(run);
  }

  cancel(runId: string): void {
    const run = this.proposed(runId);
    run.status = 'cancelled';
    this.changed(run);
  }

  /** Every session turn-end goes through here; only rows of the run named in its origins move. */
  onTurnEnd(sessionId: string, end: TurnEnd): void {
    for (const origin of end.origins) {
      if (!origin.startsWith('bulk:')) continue;
      const run = this.runs.get(origin.slice('bulk:'.length));
      const row = run?.rows.find((r) => r.sessionId === sessionId && r.status === 'running');
      if (!run || !row) continue;
      row.status = end.error ? 'error' : 'done';
      row.detail = end.error ?? end.lastText;
      this.changed(run);
      this.pump(run);
    }
  }

  recent(limit: number): BulkRun[] {
    return [...this.runs.values()]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit)
      .map(copy);
  }

  private proposed(runId: string): BulkRun {
    const run = this.runs.get(runId);
    if (!run) throw new Error(`Unknown bulk run ${runId}`);
    if (run.status !== 'proposed') throw new Error(`Bulk run ${runId} is not waiting for confirmation (${run.status})`);
    return run;
  }

  /** Starts queued rows up to the cap; finishes the run once every row is settled. */
  private pump(run: BulkRun): void {
    if (run.status !== 'running') return;
    let running = run.rows.filter((r) => r.status === 'running').length;
    for (const row of run.rows) {
      if (running >= this.concurrency) break;
      if (row.status !== 'queued') continue;
      row.status = 'running';
      running += 1;
      this.deps
        .send({ sessionId: row.sessionId, prompt: row.prompt, mode: run.mode, origin: bulkOrigin(run.id) })
        .catch((err: unknown) => {
          row.status = 'error';
          row.detail = err instanceof Error ? err.message : String(err);
          this.changed(run);
          this.pump(run);
        });
    }
    this.changed(run);
    if (run.rows.every(settled)) {
      run.status = 'finished';
      this.changed(run);
      this.emit('finished', copy(run));
    }
  }

  private changed(run: BulkRun): void {
    this.emit('changed', copy(run));
  }
}
