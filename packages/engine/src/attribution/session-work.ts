import { isAbsolute, join, relative } from 'node:path';
import type { TranscriptEntry } from '@relay/shared';

/** Enough commits to recognise the work, before a count speaks for the rest. */
export const COMMITS_SHOWN = 5;
/** A file list longer than this stops being readable. */
export const FILES_SHOWN = 10;

/**
 * Tools whose input names the file they changed.
 *
 * `Bash` is deliberately absent. A shell line can write anything, and guessing which paths in
 * it were written rather than read would put work on a session that it never did. Files changed
 * through the shell are therefore missed — under-reporting is the honest failure here.
 */
const WRITING_TOOLS: Record<string, string[]> = {
  Write: ['file_path'],
  Edit: ['file_path'],
  MultiEdit: ['file_path'],
  NotebookEdit: ['notebook_path'],
};

export interface CommitWithFiles {
  sha: string;
  subject: string;
  at: string;
  files: string[];
}

/** Repository-relative paths this session itself wrote, in the order it first touched them. */
export function filesWrittenIn(entries: TranscriptEntry[], cwd: string): string[] {
  const found = new Set<string>();
  for (const entry of entries) {
    for (const block of entry.blocks) {
      if (block.kind !== 'tool_use') continue;
      const fields = WRITING_TOOLS[block.name];
      if (!fields || typeof block.input !== 'object' || block.input === null) continue;
      for (const field of fields) {
        const value = (block.input as Record<string, unknown>)[field];
        if (typeof value !== 'string' || value === '') continue;
        const absolute = isAbsolute(value) ? value : join(cwd, value);
        const rel = relative(cwd, absolute);
        // a file outside the session's own directory is not this branch's work
        if (!rel.startsWith('..')) found.add(rel);
      }
    }
  }
  return [...found];
}

/** When the session was active: from its first entry to its last. */
export function spanOf(entries: TranscriptEntry[]): { from: string | null; to: string | null } {
  const stamps = entries.map((e) => e.timestamp).filter((t) => typeof t === 'string' && t !== '');
  if (stamps.length === 0) return { from: null, to: null };
  const sorted = [...stamps].sort();
  return { from: sorted[0]!, to: sorted[sorted.length - 1]! };
}

/**
 * The commits that are this session's, out of everything on the branch.
 *
 * A commit counts only when it touches a file the session wrote. Work merged in from elsewhere
 * touches other files, so it falls away; and a commit that only happens to sit in the same
 * window is not claimed. Where two sessions edited the same file in the same period, the commit
 * is claimed by both — that is the one case this cannot separate, and it over-reports rather
 * than inventing a winner.
 */
export function attribute(commits: CommitWithFiles[], written: string[]): CommitWithFiles[] {
  if (written.length === 0) return [];
  const mine = new Set(written);
  return commits.filter((c) => c.files.some((f) => mine.has(f)));
}

/**
 * Every file this session is responsible for: what it wrote where the session was opened, plus
 * everything carried by the commits attributed to it.
 *
 * A session often works in a worktree of the same repository rather than in the directory it was
 * opened in, and that worktree is usually deleted once the branch lands. Those paths cannot be
 * resolved from disk afterwards — but a commit that has already been attributed names them, and
 * every file in a commit the session made is the session's work.
 */
export function filesOf(written: string[], attributed: CommitWithFiles[]): string[] {
  return [...new Set([...written, ...attributed.flatMap((c) => c.files)])].sort();
}
