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
      message: { role: 'user', content: m.text },
      parent_tool_use_id: null,
      priority: m.priority,
      origin: { kind: 'human' },
    };
  }
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
    case 'result': {
      if (m.subtype === 'success') {
        return { type: 'result', isError: m.is_error, error: m.is_error ? m.result : null };
      }
      const errors = 'errors' in m && Array.isArray(m.errors) ? m.errors.join('; ') : '';
      return { type: 'result', isError: true, error: errors ? `${m.subtype}: ${errors}` : m.subtype };
    }
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
