import { DatabaseSync } from 'node:sqlite';
import type { SessionSummary } from '@relay/shared';

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
      )
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

  close(): void {
    this.db.close();
  }
}

function toCached(row: Row): CachedSession {
  return { summary: JSON.parse(row.summary) as SessionSummary, mtimeMs: row.mtime_ms, size: row.size };
}
