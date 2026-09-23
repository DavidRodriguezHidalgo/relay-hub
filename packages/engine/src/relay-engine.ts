import type { SessionSummary, TranscriptEntry } from '@relay/shared';
import { ExecGitInfoProvider, type GitInfoProvider } from './git/git-info';
import { SessionIndex } from './index/session-index';
import { SessionStore } from './store/session-store';

export interface RelayEngineOptions {
  projectsDir: string;
  dbPath: string;
  git?: GitInfoProvider;
}

/** The single entry point the desktop app (and later a daemon) talks to. */
export class RelayEngine {
  private constructor(
    private readonly store: SessionStore,
    private readonly index: SessionIndex,
  ) {}

  static async start(opts: RelayEngineOptions): Promise<RelayEngine> {
    const store = new SessionStore(opts.dbPath);
    const index = new SessionIndex({
      projectsDir: opts.projectsDir,
      store,
      git: opts.git ?? new ExecGitInfoProvider(),
    });
    await index.scan();
    index.watch();
    return new RelayEngine(store, index);
  }

  listSessions(): SessionSummary[] {
    return this.index.list();
  }

  getTranscript(id: string): Promise<TranscriptEntry[]> {
    return this.index.getTranscript(id);
  }

  onSessionsChanged(listener: (sessions: SessionSummary[]) => void): () => void {
    this.index.on('changed', listener);
    return () => this.index.off('changed', listener);
  }

  async close(): Promise<void> {
    await this.index.close();
    this.store.close();
  }
}
