import { EventEmitter } from 'node:events';
import { access, readdir, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { watch as chokidarWatch, type FSWatcher } from 'chokidar';
import type { SessionSummary, TranscriptEntry } from '@relay/shared';
import type { GitInfoProvider } from '../git/git-info';
import type { SessionStore } from '../store/session-store';
import { readTranscript } from '../transcript/parse-transcript';

const STALE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

export interface SessionIndexOptions {
  projectsDir: string;
  store: SessionStore;
  git: GitInfoProvider;
  now?: () => Date;
  debounceMs?: number;
  /** Longest a burst of writes can delay a change event; a session writing non-stop still updates. */
  maxWaitMs?: number;
  /** Transcript reader; injectable for tests. */
  read?: typeof readTranscript;
}

type IndexEvents = { changed: [SessionSummary[]]; error: [Error] };

/** Discovers Claude Code sessions on disk, caches their summaries and reports changes. */
export class SessionIndex extends EventEmitter<IndexEvents> {
  private readonly opts: Required<SessionIndexOptions>;
  private watcher: FSWatcher | null = null;
  private rescanTimer: NodeJS.Timeout | null = null;
  private sessions = new Map<string, SessionSummary>();
  /** Transcripts with no usable session (e.g. no cwd), by file signature, so they are not re-read. */
  private readonly unusable = new Map<string, { mtimeMs: number; size: number }>();
  /** Scans run one at a time; this is the last one queued. */
  private chain: Promise<unknown> = Promise.resolve();
  private closed = false;
  private burstStarted: number | null = null;

  constructor(opts: SessionIndexOptions) {
    super();
    this.opts = { now: () => new Date(), debounceMs: 300, maxWaitMs: 2_000, read: readTranscript, ...opts };
  }

  /** One scan at a time; a file that cannot be read or parsed is skipped, never hiding the rest. */
  scan(): Promise<SessionSummary[]> {
    const next = this.chain.then(() => (this.closed ? this.list() : this.scanOnce()));
    this.chain = next.catch(() => undefined);
    return next;
  }

  private async scanOnce(): Promise<SessionSummary[]> {
    const files = await this.listTranscriptFiles();
    const summaries: SessionSummary[] = [];
    for (const filePath of files) {
      try {
        const summary = await this.summarize(filePath);
        if (summary) summaries.push(summary);
      } catch (err) {
        this.report(err);
      }
    }
    if (this.closed) return this.list();
    this.opts.store.removeMissing(files);
    // the same session id in two files (a copied or moved project dir): the newest wins
    const byId = new Map<string, SessionSummary>();
    for (const s of summaries) {
      const seen = byId.get(s.id);
      if (!seen || s.lastActivity > seen.lastActivity) byId.set(s.id, s);
    }
    this.sessions = byId;
    return this.list();
  }

  list(): SessionSummary[] {
    return [...this.sessions.values()].sort((a, b) => b.lastActivity.localeCompare(a.lastActivity));
  }

  async getTranscript(id: string): Promise<TranscriptEntry[]> {
    const session = this.sessions.get(id);
    if (!session) throw new Error(`Unknown session ${id}`);
    return (await this.opts.read(session.filePath)).entries;
  }

  watch(): void {
    if (this.watcher) return;
    this.watcher = chokidarWatch(this.opts.projectsDir, {
      ignoreInitial: true,
      depth: 1,
      ignored: (path, stats) => !!stats?.isFile() && !path.endsWith('.jsonl'),
    });
    const schedule = () => {
      const now = Date.now();
      this.burstStarted ??= now;
      if (this.rescanTimer) clearTimeout(this.rescanTimer);
      const waited = now - this.burstStarted;
      const delay = Math.max(0, Math.min(this.opts.debounceMs, this.opts.maxWaitMs - waited));
      this.rescanTimer = setTimeout(() => {
        this.rescanTimer = null;
        this.burstStarted = null;
        this.scan()
          .then((s) => this.emit('changed', s))
          .catch((err: unknown) => this.report(err));
      }, delay);
    };
    this.watcher.on('add', schedule).on('change', schedule).on('unlink', schedule);
  }

  /** Stops watching and waits for a scan in flight, so nothing touches the store after close. */
  async close(): Promise<void> {
    this.closed = true;
    if (this.rescanTimer) clearTimeout(this.rescanTimer);
    await this.watcher?.close();
    this.watcher = null;
    await this.chain;
  }

  /** `<projectsDir>/<project>/<id>.jsonl` only; nested dirs such as `subagents/` are skipped. */
  private async listTranscriptFiles(): Promise<string[]> {
    const files: string[] = [];
    let projects: string[];
    try {
      projects = await readdir(this.opts.projectsDir);
    } catch {
      return files;
    }
    for (const project of projects) {
      const dir = join(this.opts.projectsDir, project);
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        if (e.isFile() && e.name.endsWith('.jsonl')) files.push(join(dir, e.name));
      }
    }
    return files;
  }

  /**
   * Cache hits still re-check that the cwd exists: a finished session's transcript never changes,
   * but its worktree can be deleted (or restored) at any time.
   */
  private async summarize(filePath: string): Promise<SessionSummary | null> {
    const st = await stat(filePath);
    const cached = this.opts.store.get(filePath);
    if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
      const cwdExists = await exists(cached.summary.cwd);
      if (cwdExists === cached.summary.cwdExists) return this.refreshStale(cached.summary);
    }
    const skipped = this.unusable.get(filePath);
    if (skipped && skipped.mtimeMs === st.mtimeMs && skipped.size === st.size) return null;
    const parsed = await this.opts.read(filePath, { entries: false });
    if (!parsed.cwd || !parsed.lastActivity) {
      this.unusable.set(filePath, { mtimeMs: st.mtimeMs, size: st.size });
      return null;
    }
    this.unusable.delete(filePath);
    const cwdExists = await exists(parsed.cwd);
    const git = cwdExists ? await this.opts.git.inspect(parsed.cwd) : { branch: null, repo: null };
    const summary: SessionSummary = {
      id: parsed.sessionId ?? basename(filePath, '.jsonl'),
      filePath,
      cwd: parsed.cwd,
      cwdExists,
      repo: git.repo ?? basename(parsed.cwd),
      // The transcript's own branch identifies the session; the live checkout only helps when it is missing.
      branch: cwdExists ? (parsed.gitBranch ?? git.branch) : null,
      title: parsed.title,
      lastActivity: parsed.lastActivity,
      messageCount: parsed.messageCount,
      prNumber: parsed.prNumber,
      prUrl: parsed.prUrl,
      continuedIn: parsed.continuedIn,
      isStale: false,
    };
    const fresh = this.refreshStale(summary);
    this.opts.store.upsert({ summary: fresh, mtimeMs: st.mtimeMs, size: st.size });
    return fresh;
  }

  /** Node throws on an unlistened 'error' emit, so only report when someone is listening. */
  private report(err: unknown): void {
    if (this.listenerCount('error') > 0) this.emit('error', err instanceof Error ? err : new Error(String(err)));
  }

  private refreshStale(summary: SessionSummary): SessionSummary {
    const tooOld = this.opts.now().getTime() - Date.parse(summary.lastActivity) > STALE_AFTER_MS;
    return { ...summary, isStale: !summary.cwdExists || tooOld };
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
