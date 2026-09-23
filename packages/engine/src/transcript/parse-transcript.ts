import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import type { TranscriptBlock, TranscriptEntry } from '@relay/shared';

export interface ParsedTranscript {
  sessionId: string | null;
  cwd: string | null;
  gitBranch: string | null;
  title: string;
  lastActivity: string | null;
  messageCount: number;
  prNumber: number | null;
  prUrl: string | null;
  continuedIn: string | null;
  entries: TranscriptEntry[];
}

const TITLE_MAX = 80;
const UNTITLED = 'Untitled session';

type RawBlock = {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
};

type RawLine = {
  type?: string;
  uuid?: string;
  timestamp?: string;
  cwd?: string;
  gitBranch?: string;
  sessionId?: string;
  isSidechain?: boolean;
  isMeta?: boolean;
  message?: { role?: string; content?: string | RawBlock[] };
  aiTitle?: string;
  customTitle?: string;
  prNumber?: number;
  prUrl?: string;
  relocatedCwd?: string;
  continuedInSessionId?: string;
};

function toBlocks(content: string | RawBlock[] | undefined): TranscriptBlock[] {
  if (typeof content === 'string') return [{ kind: 'text', text: content }];
  if (!Array.isArray(content)) return [];
  const blocks: TranscriptBlock[] = [];
  for (const b of content) {
    switch (b.type) {
      case 'text':
        blocks.push({ kind: 'text', text: b.text ?? '' });
        break;
      case 'thinking':
        blocks.push({ kind: 'thinking' });
        break;
      case 'tool_use':
        blocks.push({ kind: 'tool_use', id: b.id ?? '', name: b.name ?? '', input: b.input });
        break;
      case 'tool_result':
        blocks.push({
          kind: 'tool_result',
          toolUseId: b.tool_use_id ?? '',
          text: toolResultText(b.content),
          isError: b.is_error === true,
        });
        break;
      case 'image':
        blocks.push({ kind: 'image' });
        break;
    }
  }
  return blocks;
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c: RawBlock) => (c.type === 'text' ? (c.text ?? '') : '[image]'))
      .join('\n');
  }
  return '';
}

function firstText(blocks: TranscriptBlock[]): string | null {
  const t = blocks.find((b) => b.kind === 'text');
  return t && t.kind === 'text' ? t.text : null;
}

/** Parses transcript lines; unparsable lines (e.g. a write in progress) are skipped. */
export function parseTranscriptLines(lines: Iterable<string>): ParsedTranscript {
  const out: ParsedTranscript = {
    sessionId: null,
    cwd: null,
    gitBranch: null,
    title: UNTITLED,
    lastActivity: null,
    messageCount: 0,
    prNumber: null,
    prUrl: null,
    continuedIn: null,
    entries: [],
  };
  let aiTitle: string | null = null;
  let customTitle: string | null = null;
  let promptTitle: string | null = null;
  let relocatedCwd: string | null = null;

  for (const line of lines) {
    if (!line.trim()) continue;
    let raw: RawLine;
    try {
      raw = JSON.parse(line) as RawLine;
    } catch {
      continue;
    }
    out.sessionId ??= raw.sessionId ?? null;
    switch (raw.type) {
      case 'ai-title':
        aiTitle = raw.aiTitle ?? aiTitle;
        break;
      case 'custom-title':
        customTitle = raw.customTitle ?? customTitle;
        break;
      case 'pr-link':
        out.prNumber = raw.prNumber ?? out.prNumber;
        out.prUrl = raw.prUrl ?? out.prUrl;
        break;
      case 'relocated':
        relocatedCwd = raw.relocatedCwd ?? relocatedCwd;
        break;
      case 'continued-in':
        out.continuedIn = raw.continuedInSessionId ?? out.continuedIn;
        break;
      case 'user':
      case 'assistant': {
        if (!raw.uuid || !raw.timestamp) break;
        const entry: TranscriptEntry = {
          uuid: raw.uuid,
          role: raw.type,
          timestamp: raw.timestamp,
          isSidechain: raw.isSidechain === true,
          isMeta: raw.isMeta === true,
          blocks: toBlocks(raw.message?.content),
        };
        out.entries.push(entry);
        if (!entry.isSidechain) {
          out.messageCount += 1;
          out.lastActivity = raw.timestamp;
          if (raw.cwd) out.cwd = raw.cwd;
          if (raw.gitBranch) out.gitBranch = raw.gitBranch;
          if (
            promptTitle === null &&
            entry.role === 'user' &&
            !entry.isMeta &&
            typeof raw.message?.content === 'string'
          ) {
            promptTitle = firstText(entry.blocks);
          }
        }
        break;
      }
    }
  }

  if (relocatedCwd) out.cwd = relocatedCwd;
  const title = customTitle ?? aiTitle ?? promptTitle;
  out.title = title ? title.trim().slice(0, TITLE_MAX) || UNTITLED : UNTITLED;
  return out;
}

/** Streams a JSONL transcript from disk; large files are never read whole. */
export async function readTranscript(filePath: string): Promise<ParsedTranscript> {
  const lines: string[] = [];
  const rl = createInterface({ input: createReadStream(filePath, 'utf8'), crlfDelay: Infinity });
  for await (const line of rl) lines.push(line);
  return parseTranscriptLines(lines);
}
