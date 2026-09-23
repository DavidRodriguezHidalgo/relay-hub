import { DatabaseSync } from 'node:sqlite';
import type { BulkRun, SessionSummary } from '@relay/shared';

export interface CachedSession {
  summary: SessionSummary;
  mtimeMs: number;
  size: number;
}

type Row = { file_path: string; mtime_ms: number; size: number; summary: string };

/** Persists parsed session summaries keyed by transcript path, with the file signature used to skip re-parsing. */
export class SessionStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      create table if not exists sessions (
        file_path text primary key,
        mtime_ms real not null,
        size integer not null,
        summary text not null
      );
      create table if not exists meta (key text primary key, value text not null);
      create table if not exists bulk_runs (id text primary key, created_at text not null, run text not null);
    `);
  }

  get(filePath: string): CachedSession | null {
    const row = this.db.prepare('select * from sessions where file_path = ?').get(filePath) as Row | undefined;
    return row ? toCached(row) : null;
  }

  upsert(entry: CachedSession): void {
    this.db
      .prepare(
        `insert into sessions (file_path, mtime_ms, size, summary) values (?, ?, ?, ?)
         on conflict(file_path) do update set mtime_ms = excluded.mtime_ms, size = excluded.size, summary = excluded.summary`,
      )
      .run(entry.summary.filePath, entry.mtimeMs, entry.size, JSON.stringify(entry.summary));
  }

  all(): CachedSession[] {
    return (this.db.prepare('select * from sessions').all() as Row[]).map(toCached);
  }

  removeMissing(presentFilePaths: string[]): void {
    const present = new Set(presentFilePaths);
    const del = this.db.prepare('delete from sessions where file_path = ?');
    for (const row of this.db.prepare('select file_path from sessions').all() as Pick<Row, 'file_path'>[]) {
      if (!present.has(row.file_path)) del.run(row.file_path);
    }
  }

  getMeta(key: string): string | null {
    const row = this.db.prepare('select value from meta where key = ?').get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  /** `null` deletes the key. */
  setMeta(key: string, value: string | null): void {
    if (value === null) {
      this.db.prepare('delete from meta where key = ?').run(key);
    } else {
      this.db
        .prepare('insert into meta (key, value) values (?, ?) on conflict(key) do update set value = excluded.value')
        .run(key, value);
    }
  }

  saveBulkRun(run: BulkRun): void {
    this.db
      .prepare(
        'insert into bulk_runs (id, created_at, run) values (?, ?, ?) on conflict(id) do update set run = excluded.run',
      )
      .run(run.id, run.createdAt, JSON.stringify(run));
  }

  /** Newest first. */
  loadBulkRuns(limit: number): BulkRun[] {
    const rows = this.db.prepare('select run from bulk_runs order by created_at desc limit ?').all(limit) as {
      run: string;
    }[];
    return rows.map((r) => JSON.parse(r.run) as BulkRun);
  }

  close(): void {
    this.db.close();
  }
}

function toCached(row: Row): CachedSession {
  return { summary: JSON.parse(row.summary) as SessionSummary, mtimeMs: row.mtime_ms, size: row.size };
}
