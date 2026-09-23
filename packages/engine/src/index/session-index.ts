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
}

/** Discovers Claude Code sessions on disk, caches their summaries and reports changes. */
export class SessionIndex extends EventEmitter<{ changed: [SessionSummary[]] }> {
  private readonly opts: Required<SessionIndexOptions>;
  private watcher: FSWatcher | null = null;
  private rescanTimer: NodeJS.Timeout | null = null;
  private sessions = new Map<string, SessionSummary>();

  constructor(opts: SessionIndexOptions) {
    super();
    this.opts = { now: () => new Date(), debounceMs: 300, ...opts };
  }

  async scan(): Promise<SessionSummary[]> {
    const files = await this.listTranscriptFiles();
    const summaries: SessionSummary[] = [];
    for (const filePath of files) {
      const summary = await this.summarize(filePath);
      if (summary) summaries.push(summary);
    }
    this.opts.store.removeMissing(files);
    this.sessions = new Map(summaries.map((s) => [s.id, s]));
    return this.list();
  }

  list(): SessionSummary[] {
    return [...this.sessions.values()].sort((a, b) => b.lastActivity.localeCompare(a.lastActivity));
  }

  async getTranscript(id: string): Promise<TranscriptEntry[]> {
    const session = this.sessions.get(id);
    if (!session) throw new Error(`Unknown session ${id}`);
    return (await readTranscript(session.filePath)).entries;
  }

  watch(): void {
    if (this.watcher) return;
    this.watcher = chokidarWatch(this.opts.projectsDir, {
      ignoreInitial: true,
      depth: 1,
      ignored: (path, stats) => !!stats?.isFile() && !path.endsWith('.jsonl'),
    });
    const schedule = () => {
      if (this.rescanTimer) clearTimeout(this.rescanTimer);
      this.rescanTimer = setTimeout(() => {
        this.rescanTimer = null;
        void this.scan().then((s) => this.emit('changed', s));
      }, this.opts.debounceMs);
    };
    this.watcher.on('add', schedule).on('change', schedule).on('unlink', schedule);
  }

  async close(): Promise<void> {
    if (this.rescanTimer) clearTimeout(this.rescanTimer);
    await this.watcher?.close();
    this.watcher = null;
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

  private async summarize(filePath: string): Promise<SessionSummary | null> {
    const st = await stat(filePath);
    const cached = this.opts.store.get(filePath);
    if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
      return this.refreshStale(cached.summary);
    }
    const parsed = await readTranscript(filePath);
    if (!parsed.cwd || !parsed.lastActivity) return null;
    const cwdExists = await exists(parsed.cwd);
    const git = cwdExists ? await this.opts.git.inspect(parsed.cwd) : { branch: null, repo: null };
    const summary: SessionSummary = {
      id: parsed.sessionId ?? basename(filePath, '.jsonl'),
      filePath,
      cwd: parsed.cwd,
      cwdExists,
      repo: git.repo ?? basename(parsed.cwd),
      branch: cwdExists ? (git.branch ?? parsed.gitBranch) : null,
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
