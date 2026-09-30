/**
 * Why a session's last turn ended badly.
 *
 * These need different answers, so they are told apart rather than lumped into "error": a usage
 * limit resets on its own and is nobody's bug, a login is fixed in a terminal, and a crash is
 * worth looking at. `unknown` is used honestly when the cause cannot be told.
 */
export type FailureKind = 'usage-limit' | 'authentication' | 'tool' | 'crash' | 'unknown';

export interface SessionFailure {
  kind: FailureKind;
  /** Short enough to sit in a listing; the full text stays in the transcript. */
  message: string;
  /** When the turn failed. */
  at: string;
  /** When a usage limit frees up, if the message said so. */
  resetsAt?: string;
}

/** What each kind means for whoever reads it, in one line. */
export const FAILURE_MEANING: Record<FailureKind, string> = {
  'usage-limit': 'Out of usage for now; it will work again by itself.',
  authentication: 'Claude Code is not logged in. Log in, then send again.',
  tool: 'A tool the session ran failed.',
  crash: 'The session ended unexpectedly.',
  unknown: 'The turn failed; the cause could not be told from the message.',
};
