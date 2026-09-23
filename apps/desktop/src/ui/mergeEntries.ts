import type { LiveEntry, TranscriptEntry } from '@relay/shared';
import type { ViewEntry } from './TranscriptView';

/** File entries first, then live ones the file has not caught up with yet. */
export function mergeEntries(entries: TranscriptEntry[], live: LiveEntry[]): ViewEntry[] {
  const seen = new Set(entries.map((e) => e.uuid));
  return [...entries, ...live.filter((e) => !seen.has(e.uuid))];
}
