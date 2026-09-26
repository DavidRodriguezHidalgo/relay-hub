export type TranscriptBlock =
  | { kind: 'text'; text: string }
  | { kind: 'thinking' }
  | { kind: 'tool_use'; id: string; name: string; input: unknown }
  | { kind: 'tool_result'; toolUseId: string; text: string; isError: boolean }
  | { kind: 'image' };

/** A user or assistant message, flattened for rendering. */
export interface TranscriptEntry {
  uuid: string;
  role: 'user' | 'assistant';
  timestamp: string;
  isSidechain: boolean;
  isMeta: boolean;
  blocks: TranscriptBlock[];
  /**
   * Set when this is not a reply but Claude Code reporting that the request itself failed, e.g.
   * `authentication_failed`. The blocks then hold its wording; the code says what happened.
   */
  apiError?: string;
}
