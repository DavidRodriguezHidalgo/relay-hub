import {
  query as sdkQuery,
  type Options,
  type SDKMessage,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { blocksFromContent } from '../transcript/parse-transcript';
import type { AgentClient, AgentInput, AgentMessage, AgentRun, AgentStartOptions } from './agent-client';

/** The shape of `query` we depend on, so tests can inject a fake. */
export type SdkQueryFn = (params: {
  prompt: string | AsyncIterable<SDKUserMessage>;
  options?: Options;
}) => AsyncGenerator<SDKMessage, void> & { interrupt(): Promise<unknown> };

async function* toSdkInput(input: AsyncIterable<AgentInput>): AsyncIterable<SDKUserMessage> {
  for await (const m of input) {
    yield {
      type: 'user',
      uuid: m.id as SDKUserMessage['uuid'],
      message: { role: 'user', content: m.text },
      parent_tool_use_id: null,
      priority: m.priority,
      origin: { kind: 'human' },
    };
  }
}

type ResultLike = {
  subtype: string;
  is_error?: boolean;
  result?: string;
  errors?: unknown;
  user_message_uuids?: string[];
  queued_turn_count?: number;
  terminal_reason?: string;
};

/**
 * An interrupted turn comes back as `is_error: true` with `terminal_reason: 'aborted_*'`;
 * that is a normal end of turn, not a failed session.
 */
function mapResult(m: ResultLike): AgentMessage {
  const aborted = typeof m.terminal_reason === 'string' && m.terminal_reason.startsWith('aborted');
  const isError = m.is_error === true && !aborted;
  let error: string | null = null;
  if (isError) {
    const details = Array.isArray(m.errors) ? m.errors.join('; ') : typeof m.result === 'string' ? m.result : '';
    error = details ? `${m.subtype}: ${details}` : m.subtype;
  }
  return {
    type: 'result',
    isError,
    error,
    queuedTurns: typeof m.queued_turn_count === 'number' ? m.queued_turn_count : null,
    settledSendIds: Array.isArray(m.user_message_uuids) ? m.user_message_uuids : [],
  };
}

function mapMessage(m: SDKMessage): AgentMessage | null {
  const now = new Date().toISOString();
  switch (m.type) {
    case 'system':
      return m.subtype === 'init' ? { type: 'init', sessionId: m.session_id } : null;
    case 'assistant':
      return { type: 'assistant', uuid: m.uuid, timestamp: now, blocks: blocksFromContent(m.message.content) };
    case 'user': {
      const content = m.message.content;
      if (typeof content === 'string') return null; // our own prompt echoed back
      const uuid = 'uuid' in m && typeof m.uuid === 'string' ? m.uuid : `${now}-tool-results`;
      return { type: 'tool-results', uuid, timestamp: now, blocks: blocksFromContent(content) };
    }
    case 'result':
      return mapResult(m as ResultLike);
    default:
      return null;
  }
}

/** Drives one Claude Code session through the Agent SDK in streaming-input mode. */
export class SdkAgentClient implements AgentClient {
  constructor(private readonly queryFn: SdkQueryFn = sdkQuery as unknown as SdkQueryFn) {}

  start(opts: AgentStartOptions): AgentRun {
    const q = this.queryFn({
      prompt: toSdkInput(opts.input),
      options: {
        resume: opts.sessionId,
        cwd: opts.cwd,
        permissionMode: 'acceptEdits',
        // Project settings and CLAUDE.md load; user/local permission allow-lists must not
        // pre-approve commands before Relay's own approval rules see them.
        settingSources: ['project'],
        canUseTool: (toolName, input, { signal, blockedPath }) =>
          opts.canUseTool(toolName, input, blockedPath, signal).then((o) =>
            o.behavior === 'allow'
              ? { behavior: 'allow' as const }
              : { behavior: 'deny' as const, message: o.message },
          ),
      },
    });
    async function* messages(): AsyncIterable<AgentMessage> {
      for await (const m of q) {
        const mapped = mapMessage(m);
        if (mapped) yield mapped;
      }
    }
    return { messages: messages(), interrupt: () => q.interrupt().then(() => undefined) };
  }
}
