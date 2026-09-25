import type { SessionSummary } from '@relay/shared';

/** Something on screen is older than what is on disk, or no longer matches it. */
export interface Staleness {
  kind: 'process' | 'transcript' | 'directory' | 'branch' | 'moved';
  message: string;
}

export interface SeenState {
  /** Channels the running app process answers; empty means it could not be asked. */
  missingChannels: number;
  /** The session as it was when this window read it. */
  shown: SessionSummary | null;
  /** The same session as the index reports it now. */
  current: SessionSummary | null;
}

/**
 * Whatever is out of date, worst first.
 *
 * The window, the transcript it drew and the directory a session lives in can each move on
 * without it. Every one of them used to surface as something obscure — a missing IPC handler,
 * a stale panel, a session quietly driving a directory that is no longer there — so each is
 * named plainly instead.
 */
export function stalenessOf(state: SeenState): Staleness | null {
  if (state.missingChannels > 0) {
    return {
      kind: 'process',
      message: 'This window is newer than the app process behind it. Restart the app.',
    };
  }
  const { shown, current } = state;
  if (!shown || !current) return null;

  if (shown.cwdExists && !current.cwdExists) {
    return {
      kind: 'moved',
      message: `The directory this session works in is gone: ${shown.cwd}. It cannot be driven until it is back.`,
    };
  }
  if (shown.cwd !== current.cwd) {
    return {
      kind: 'directory',
      message: `This session moved to ${current.cwd}. What is shown was read from ${shown.cwd}.`,
    };
  }
  if (shown.branch !== current.branch) {
    return {
      kind: 'branch',
      message: `The branch changed under this session, from ${shown.branch ?? 'none'} to ${current.branch ?? 'none'}.`,
    };
  }
  if (current.messageCount > shown.messageCount || current.lastActivity > shown.lastActivity) {
    return {
      kind: 'transcript',
      message: 'This session has gone on since this was drawn. Reopen it to catch up.',
    };
  }
  return null;
}
