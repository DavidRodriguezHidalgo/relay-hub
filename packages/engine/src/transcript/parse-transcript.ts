import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import type { ContextUse, TranscriptBlock, TranscriptEntry } from '@relay/shared';
import { contextUseFrom } from '../context/context-use';

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
  /** How full the context was at the last request; null if the model was never called. */
  contextUse: ContextUse | null;
  entries: TranscriptEntry[];
}

export interface ParseOptions {
  /** When false, entries are counted but not kept; use for summaries of large files. */
  entries?: boolean;
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

/** Flattens Anthropic message content (string or block array) into renderable blocks. */
export function blocksFromContent(content: unknown): TranscriptBlock[] {
  if (typeof content === 'string') return [{ kind: 'text', text: content }];
  if (!Array.isArray(content)) return [];
  const blocks: TranscriptBlock[] = [];
  for (const b of content as RawBlock[]) {
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

/** Incremental transcript parser: feed lines one at a time, then `finish()`. */
export class TranscriptParser {
  private readonly out: ParsedTranscript = {
    sessionId: null,
    cwd: null,
    gitBranch: null,
    title: UNTITLED,
    lastActivity: null,
    messageCount: 0,
    prNumber: null,
    prUrl: null,
    continuedIn: null,
    contextUse: null,
    entries: [],
  };
  private aiTitle: string | null = null;
  private customTitle: string | null = null;
  private promptTitle: string | null = null;
  private relocatedCwd: string | null = null;
  /** The most recent record that reported usage; read once at finish rather than per line. */
  private lastUsageRecord: unknown = null;
  private readonly keepEntries: boolean;

  constructor(opts: ParseOptions = {}) {
    this.keepEntries = opts.entries ?? true;
  }

  /** Unparsable lines (e.g. a write in progress) are skipped. */
  push(line: string): void {
    if (!line.trim()) return;
    let raw: RawLine;
    try {
      raw = JSON.parse(line) as RawLine;
    } catch {
      return;
    }
    const out = this.out;
    out.sessionId ??= raw.sessionId ?? null;
    if ((raw as { message?: { usage?: unknown } }).message?.usage) this.lastUsageRecord = raw;
    switch (raw.type) {
      case 'ai-title':
        this.aiTitle = raw.aiTitle ?? this.aiTitle;
        break;
      case 'custom-title':
        this.customTitle = raw.customTitle ?? this.customTitle;
        break;
      case 'pr-link':
        out.prNumber = raw.prNumber ?? out.prNumber;
        out.prUrl = raw.prUrl ?? out.prUrl;
        break;
      case 'relocated':
        this.relocatedCwd = raw.relocatedCwd ?? this.relocatedCwd;
        break;
      case 'continued-in':
        out.continuedIn = raw.continuedInSessionId ?? out.continuedIn;
        break;
      case 'user':
      case 'assistant': {
        if (!raw.uuid || !raw.timestamp) break;
        const isSidechain = raw.isSidechain === true;
        const isMeta = raw.isMeta === true;
        const content = raw.message?.content;
        // a typed prompt is a string; one with a pasted image arrives as blocks (text + image, no tool results)
        const typedBlocks =
          Array.isArray(content) &&
          content.some((b) => b.type === 'text') &&
          !content.some((b) => b.type === 'tool_result');
        const wantsTitle =
          this.promptTitle === null &&
          raw.type === 'user' &&
          !isSidechain &&
          !isMeta &&
          (typeof content === 'string' || typedBlocks);
        if (this.keepEntries) {
          out.entries.push({
            uuid: raw.uuid,
            role: raw.type,
            timestamp: raw.timestamp,
            isSidechain,
            isMeta,
            blocks: blocksFromContent(content),
          });
        }
        if (!isSidechain) {
          out.messageCount += 1;
          out.lastActivity = raw.timestamp;
          if (raw.cwd) out.cwd = raw.cwd;
          if (raw.gitBranch) out.gitBranch = raw.gitBranch;
          if (wantsTitle) {
            this.promptTitle =
              typeof content === 'string'
                ? content
                : ((content as RawBlock[]).find((x) => x.type === 'text')?.text ?? null);
          }
        }
        break;
      }
    }
  }

  finish(): ParsedTranscript {
    const out = this.out;
    if (this.relocatedCwd) out.cwd = this.relocatedCwd;
    const title = this.customTitle ?? this.aiTitle ?? this.promptTitle;
    out.title = title ? title.trim().slice(0, TITLE_MAX) || UNTITLED : UNTITLED;
    out.contextUse = this.lastUsageRecord ? contextUseFrom([this.lastUsageRecord]) : null;
    return out;
  }
}

export function parseTranscriptLines(lines: Iterable<string>, opts?: ParseOptions): ParsedTranscript {
  const parser = new TranscriptParser(opts);
  for (const line of lines) parser.push(line);
  return parser.finish();
}

/** Streams a JSONL transcript from disk line by line; the file is never held whole in memory. */
export async function readTranscript(filePath: string, opts?: ParseOptions): Promise<ParsedTranscript> {
  const parser = new TranscriptParser(opts);
  const rl = createInterface({ input: createReadStream(filePath, 'utf8'), crlfDelay: Infinity });
  for await (const line of rl) parser.push(line);
  return parser.finish();
}
