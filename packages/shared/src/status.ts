/** A check CI ran for a branch, as reported by the forge. */
export interface StatusCheck {
  name: string;
  /** `success`, `failure`, `pending`, `cancelled`, `skipped`… as the forge words it. */
  conclusion: string;
}

/**
 * What can be verified about a session's work, as opposed to what it said it did.
 *
 * Every field is read from git or the forge. `checks` is null when nothing could be asked —
 * no pull request, or no `gh` — and `note` says which, rather than leaving a silent blank.
 */
export interface SessionStatus {
  branch: string | null;
  lastCommit: { sha: string; subject: string; at: string } | null;
  /** Files changed but not committed. */
  uncommitted: number;
  /** Commits on this branch that the remote does not have. */
  unpushed: number;
  upstream: string | null;
  pr: { number: number; url: string; state: string } | null;
  checks: StatusCheck[] | null;
  note: string | null;
}
