import {
  createSdkMcpServer,
  query as sdkQuery,
  tool,
  type Options,
  type SDKMessage,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { blocksFromContent } from '../transcript/parse-transcript';
import type { Invocable, ModelChoice } from '@relay/shared';
import type { AgentCapabilities, AgentClient, AgentInput, AgentMessage, AgentRun, AgentStartOptions } from './agent-client';

/** Tools on Relay's in-process MCP server; the orchestrator may use nothing else. */
const RELAY_TOOL_PREFIX = 'mcp__relay__';

/** The shape of `query` we depend on, so tests can inject a fake. */
export type SdkQueryFn = (params: {
  prompt: string | AsyncIterable<SDKUserMessage>;
  options?: Options;
}) => AsyncGenerator<SDKMessage, void> & {
  interrupt(): Promise<unknown>;
  close?(): void;
  supportedCommands?(): Promise<Invocable[]>;
  supportedModels?(): Promise<{ value: string; displayName?: string; description?: string }[]>;
  setModel?(model?: string): Promise<void>;
};

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
    aborted,
    error,
    queuedTurns: typeof m.queued_turn_count === 'number' ? m.queued_turn_count : null,
    settledSendIds: Array.isArray(m.user_message_uuids) ? m.user_message_uuids : [],
  };
}

function mapMessage(m: SDKMessage): AgentMessage | null {
  const now = new Date().toISOString();
  switch (m.type) {
    case 'system':
      return m.subtype === 'init' ? { type: 'init', sessionId: m.session_id, model: (m as { model?: string }).model } : null;
    case 'assistant': {
      // Claude Code marks a synthetic 'the request failed' frame; the record on disk carries the same fields
      const failed = m as { isApiErrorMessage?: boolean; error?: string };
      return {
        type: 'assistant',
        uuid: m.uuid,
        timestamp: now,
        blocks: blocksFromContent(m.message.content),
        sendId: (m as { user_message_uuid?: string }).user_message_uuid ?? null,
        sidechain: m.parent_tool_use_id !== null,
        ...(failed.isApiErrorMessage === true ? { apiError: failed.error ?? 'api_error' } : {}),
      };
    }
    case 'user': {
      const content = m.message.content;
      if (typeof content === 'string') return null; // our own prompt echoed back
      const uuid = 'uuid' in m && typeof m.uuid === 'string' ? m.uuid : `${now}-tool-results`;
      return {
        type: 'tool-results',
        uuid,
        timestamp: now,
        blocks: blocksFromContent(content),
        sendId: null,
        sidechain: m.parent_tool_use_id !== null,
      };
    }
    case 'result':
      return mapResult(m as ResultLike);
    default:
      return null;
  }
}

function profileOptions(opts: AgentStartOptions): Options {
  const base: Options = {
    cwd: opts.cwd,
    ...(opts.sessionId ? { resume: opts.sessionId } : {}),
    ...(opts.fork ? { forkSession: true } : {}),
    ...(opts.persist === false ? { persistSession: false } : {}),
    ...(opts.model ? { model: opts.model } : {}),
  };
  const profile = opts.profile ?? { kind: 'session' };
  if (profile.kind === 'session') {
    // Every settings source loads, like the terminal: CLAUDE.md, skills, commands, plugins, hooks.
    // Their allow-lists must not pre-approve what Relay's rules hold back, so a PreToolUse
    // hook turns those calls into an ask, which reaches canUseTool.
    const needsApproval = opts.needsApproval;
    return {
      ...base,
      permissionMode: 'acceptEdits',
      settingSources: ['user', 'project', 'local'],
      ...(needsApproval
        ? {
            hooks: {
              PreToolUse: [
                {
                  hooks: [
                    async (input) => {
                      const call = input as { tool_name: string; tool_input: unknown };
                      const toolInput = (call.tool_input ?? {}) as Record<string, unknown>;
                      return needsApproval(call.tool_name, toolInput)
                        ? {
                            hookSpecificOutput: {
                              hookEventName: 'PreToolUse' as const,
                              permissionDecision: 'ask' as const,
                              permissionDecisionReason: 'Relay approval',
                            },
                          }
                        : {};
                    },
                  ],
                },
              ],
            },
          }
        : {}),
    };
  }
  const server = createSdkMcpServer({
    name: 'relay',
    alwaysLoad: true,
    tools: profile.tools.map((t) =>
      tool(t.name, t.description, t.input, async (args) => {
        // the zod generic is erased at the tool() boundary; the SDK validated args against t.input
        const r = await t.handler(args as never);
        return { content: [{ type: 'text', text: r.text }], isError: r.isError === true };
      }),
    ),
  });
  return {
    ...base,
    tools: [],
    settingSources: [],
    // only Relay's in-process server: no user, project or plugin MCP servers
    strictMcpConfig: true,
    systemPrompt: profile.systemPrompt,
    mcpServers: { relay: server },
    allowedTools: profile.tools.map((t) => `${RELAY_TOOL_PREFIX}${t.name}`),
  };
}

/** Drives one Claude Code session through the Agent SDK in streaming-input mode. */
export class SdkAgentClient implements AgentClient {
  constructor(private readonly queryFn: SdkQueryFn = sdkQuery as unknown as SdkQueryFn) {}

  /**
   * Reads the command list without running a turn: the input stream never yields, so the
   * session connects, answers, and is shut down again without spending tokens.
   */
  async describe(cwd: string): Promise<AgentCapabilities> {
    async function* never(): AsyncIterable<SDKUserMessage> {
      await new Promise<never>(() => undefined);
    }
    const q = this.queryFn({
      prompt: never(),
      options: { cwd, settingSources: ['user', 'project', 'local'] },
    });
    try {
      const [commands, models] = await Promise.all([q.supportedCommands?.() ?? [], q.supportedModels?.() ?? []]);
      return {
        commands: commands.map((c) => ({ name: c.name, description: c.description, argumentHint: c.argumentHint ?? '' })),
        models: models.map(
          (m): ModelChoice => ({ id: m.value, name: m.displayName ?? m.value, description: m.description ?? '', current: false }),
        ),
      };
    } finally {
      q.close?.();
    }
  }

  start(opts: AgentStartOptions): AgentRun {
    const q = this.queryFn({
      prompt: toSdkInput(opts.input),
      options: {
        ...profileOptions(opts),
        canUseTool: (toolName, input, { signal, blockedPath }) =>
          opts.profile?.kind === 'orchestrator' && !toolName.startsWith(RELAY_TOOL_PREFIX)
            ? Promise.resolve({ behavior: 'deny' as const, message: 'The orchestrator may only use Relay tools.' })
            :           opts.canUseTool(toolName, input, blockedPath, signal).then((o) =>
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
    return {
      messages: messages(),
      interrupt: () => q.interrupt().then(() => undefined),
      setModel: q.setModel ? (model: string) => q.setModel!(model) : undefined,
    };
  }
}
