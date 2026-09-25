import { isAbsolute, join, basename } from 'node:path';
import type { TranscriptEntry } from '@relay/shared';

/** The image kinds Relay recognises, and what to label one as when inlining it. */
const MEDIA_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};
const IMAGE_SUFFIXES = Object.keys(MEDIA_TYPES);

/** What to call an image when handing it to the window; falls back to raw bytes. */
export function mediaTypeOf(name: string): string {
  const lower = name.toLowerCase();
  const suffix = IMAGE_SUFFIXES.find((s) => lower.endsWith(s));
  return (suffix && MEDIA_TYPES[suffix]) || 'application/octet-stream';
}

/**
 * Tools that can put a file on disk.
 *
 * Reading, searching or fetching an image is not producing one: a session that looked at a
 * design file has not made a screenshot of its work, and saying so would be a lie.
 */
const PRODUCING_TOOLS = new Set(['Bash', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

/** An image a tool was asked to write, before it is known whether the file is still there. */
export interface FoundImage {
  path: string;
  name: string;
  at: string;
  tool: string;
}

/**
 * Splits a tool's input into candidate words; quoting and punctuation are not path characters.
 * A colon is left alone so that a web address survives in one piece and can be recognised as one.
 */
function words(input: unknown): string[] {
  const text = typeof input === 'string' ? input : JSON.stringify(input ?? '');
  return text.split(/[\s"'`,;()[\]{}<>|\\]+/).filter(Boolean);
}

function looksLikeImage(word: string): boolean {
  const lower = word.toLowerCase();
  // a remote address names an image someone else made; only files this session wrote count
  if (lower.includes('://')) return false;
  return IMAGE_SUFFIXES.some((suffix) => lower.endsWith(suffix));
}

/**
 * Images a session asked a tool to write, newest first.
 *
 * Only `tool_use` blocks are read. What the user typed is not evidence, and a tool's reply is
 * prose that happens to mention a name — neither means a file was produced. Nothing here checks
 * the file system; the caller decides which of these still exist.
 */
export function imagesIn(entries: TranscriptEntry[], cwd: string): FoundImage[] {
  const found = new Map<string, FoundImage>();
  for (const entry of [...entries].reverse()) {
    for (const block of entry.blocks) {
      if (block.kind !== 'tool_use' || !PRODUCING_TOOLS.has(block.name)) continue;
      for (const word of words(block.input)) {
        if (!looksLikeImage(word)) continue;
        const path = isAbsolute(word) ? word : join(cwd, word);
        if (!found.has(path)) found.set(path, { path, name: basename(path), at: entry.timestamp, tool: block.name });
      }
    }
  }
  return [...found.values()];
}
