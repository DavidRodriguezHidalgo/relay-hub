import { describe, expect, it } from 'vitest';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { SdkAgentClient, type SdkQueryFn } from '../../src/runner/sdk-agent-client';
import { AsyncQueue } from '../../src/runner/async-queue';
import { z } from 'zod';
import type { AgentInput, AgentTool } from '../../src/runner/agent-client';

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

type FakeGen = AsyncGenerator<unknown, void> & {
  interrupt: () => Promise<void>;
  close?: () => void;
  supportedCommands?: () => Promise<{ name: string; description: string; argumentHint: string }[]>;
};

describe('SdkAgentClient', () => {
  it('starts an orchestrator: no resume, no built-in tools, only Relay tools over in-process MCP', async () => {
    let seen: Parameters<SdkQueryFn>[0] | null = null;
    const fakeQuery = ((params: Parameters<SdkQueryFn>[0]) => {
      seen = params;
      async function* gen() {}
      const g = gen() as FakeGen;
      g.interrupt = async () => undefined;
      return g;
    }) as unknown as SdkQueryFn;
    const echo: AgentTool = {
      name: 'echo',
      description: 'Echo',
      input: { text: z.string() },
      handler: async (args) => ({ text: String(args.text) }),
    };
    const run = new SdkAgentClient(fakeQuery).start({
      sessionId: null,
      cwd: '/orch',
      input: new AsyncQueue(),
      canUseTool: async () => ({ behavior: 'allow' }),
      profile: { kind: 'orchestrator', systemPrompt: 'You route.', tools: [echo] },
    });
    await collect(run.messages);
    const o = seen!.options!;
    expect(o.resume).toBeUndefined();
    expect(o).toMatchObject({
      cwd: '/orch', tools: [], settingSources: [], systemPrompt: 'You route.', allowedTools: ['mcp__relay__echo'],
    });
    expect(Object.keys(o.mcpServers ?? {})).toEqual(['relay']);
    expect(o.strictMcpConfig).toBe(true);
    // defence in depth: anything that is not a Relay tool is refused before the approval rules see it
    const toolOpts = { signal: new AbortController().signal } as Parameters<NonNullable<Options['canUseTool']>>[2];
    expect(await o.canUseTool!('mcp__slack__post', {}, toolOpts)).toMatchObject({ behavior: 'deny' });
    expect(await o.canUseTool!('mcp__relay__echo', {}, toolOpts)).toEqual({ behavior: 'allow' });
  });

  it('passes resume, cwd, acceptEdits and a canUseTool bridge to query(), and maps messages', async () => {
    let seen: Parameters<SdkQueryFn>[0] | null = null;
    let interrupted = false;
    const fakeQuery = ((params: Parameters<SdkQueryFn>[0]) => {
      seen = params;
      async function* gen() {
        yield { type: 'system', subtype: 'init', session_id: 'abc', cwd: '/r', model: 'm', permissionMode: 'acceptEdits' };
        yield {
          type: 'assistant', uuid: 'a1', session_id: 'abc', parent_tool_use_id: null,
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'hi' }, { type: 'tool_use', id: 't', name: 'Bash', input: { command: 'ls' } }],
          },
        };
        yield {
          type: 'user', uuid: 'u1', session_id: 'abc', parent_tool_use_id: null,
          message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }] },
        };
        yield { type: 'result', subtype: 'success', is_error: false, session_id: 'abc', result: 'done' };
      }
      const g = gen() as FakeGen;
      g.interrupt = async () => {
        interrupted = true;
      };
      return g;
    }) as unknown as SdkQueryFn;
    const client = new SdkAgentClient(fakeQuery);
    const input = new AsyncQueue<AgentInput>();
    const run = client.start({ sessionId: 'abc', cwd: '/r', input, canUseTool: async () => ({ behavior: 'allow' }) });
    const msgs = await collect(run.messages);
    await run.interrupt();

    expect(seen!.options).toMatchObject({ resume: 'abc', cwd: '/r', permissionMode: 'acceptEdits', settingSources: ['user', 'project', 'local'] });
    expect(typeof seen!.options!.canUseTool).toBe('function');
    expect(msgs).toEqual([
      { type: 'init', sessionId: 'abc', model: 'm' },
      {
        type: 'assistant', uuid: 'a1', timestamp: expect.any(String),
        blocks: [{ kind: 'text', text: 'hi' }, { kind: 'tool_use', id: 't', name: 'Bash', input: { command: 'ls' } }],
        sendId: null, sidechain: false,
      },
      {
        type: 'tool-results', uuid: 'u1', timestamp: expect.any(String),
        blocks: [{ kind: 'tool_result', toolUseId: 't', text: 'ok', isError: false }],
        sendId: null, sidechain: false,
      },
      { type: 'result', isError: false, aborted: false, error: null, queuedTurns: null, settledSendIds: [] },
    ]);
    expect(interrupted).toBe(true);
  });

  it('stamps each send id as the SDK user message uuid and reads turn accounting back from results', async () => {
    const received: unknown[] = [];
    const fakeQuery = ((params: Parameters<SdkQueryFn>[0]) => {
      async function* gen() {
        for await (const m of params.prompt as AsyncIterable<{ uuid?: string }>) received.push(m.uuid);
        yield {
          type: 'result', subtype: 'success', is_error: false, session_id: 's', result: 'ok',
          user_message_uuids: ['id-1'], queued_turn_count: 1,
        };
        // an interrupted turn, exactly as the SDK reports it
        yield { type: 'result', subtype: 'error_during_execution', is_error: true, session_id: 's', terminal_reason: 'aborted_streaming', user_message_uuids: ['id-1'], queued_turn_count: 0 };
      }
      const g = gen() as FakeGen;
      g.interrupt = async () => undefined;
      return g;
    }) as unknown as SdkQueryFn;
    const input = new AsyncQueue<AgentInput>();
    input.push({ id: 'id-1', text: 'a', priority: 'now', origin: 'user' });
    input.push({ id: 'id-2', text: 'b', priority: 'next', origin: 'user' });
    input.end();
    const run = new SdkAgentClient(fakeQuery).start({
      sessionId: 's', cwd: '/r', input, canUseTool: async () => ({ behavior: 'allow' }),
    });
    const msgs = await collect(run.messages);
    expect(received).toEqual(['id-1', 'id-2']);
    expect(msgs).toEqual([
      { type: 'result', isError: false, aborted: false, error: null, queuedTurns: 1, settledSendIds: ['id-1'] },
      // what the SDK really sends for an interrupted turn: is_error true, terminal_reason aborted_*
      { type: 'result', isError: false, aborted: true, error: null, queuedTurns: 0, settledSendIds: ['id-1'] },
    ]);
  });

  it('turns AgentInput into SDK user messages with priority and a human origin', async () => {
    const received: unknown[] = [];
    const fakeQuery = ((params: Parameters<SdkQueryFn>[0]) => {
      async function* gen() {
        for await (const m of params.prompt as AsyncIterable<unknown>) received.push(m);
      }
      const g = gen() as FakeGen;
      g.interrupt = async () => undefined;
      return g;
    }) as unknown as SdkQueryFn;
    const input = new AsyncQueue<AgentInput>();
    input.push({ id: 'u1', text: 'do x', priority: 'now', origin: 'orchestrator' });
    input.push({ id: 'u2', text: 'then y', priority: 'next', origin: 'watch:ci_failed' });
    input.end();
    const run = new SdkAgentClient(fakeQuery).start({
      sessionId: 's', cwd: '/r', input, canUseTool: async () => ({ behavior: 'allow' }),
    });
    await collect(run.messages);
    expect(received).toEqual([
      { type: 'user', uuid: 'u1', message: { role: 'user', content: 'do x' }, parent_tool_use_id: null, priority: 'now', origin: { kind: 'human' } },
      { type: 'user', uuid: 'u2', message: { role: 'user', content: 'then y' }, parent_tool_use_id: null, priority: 'next', origin: { kind: 'human' } },
    ]);
  });

  it("loads the user's skills, commands and plugins, and sends calls Relay must approve to canUseTool even when settings allow them", async () => {
    let seen: Parameters<SdkQueryFn>[0] | null = null;
    const fakeQuery = ((params: Parameters<SdkQueryFn>[0]) => {
      seen = params;
      async function* gen() {}
      const g = gen() as FakeGen;
      g.interrupt = async () => undefined;
      return g;
    }) as unknown as SdkQueryFn;
    const asked: unknown[] = [];
    new SdkAgentClient(fakeQuery).start({
      sessionId: 's', cwd: '/r', input: new AsyncQueue(), canUseTool: async () => ({ behavior: 'allow' }),
      needsApproval: (toolName, input) => {
        asked.push([toolName, input]);
        return input.command === 'git reset --hard';
      },
    });
    const [matcher] = seen!.options!.hooks!.PreToolUse!;
    const hook = (command: string) =>
      matcher!.hooks[0]!(
        { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, tool_use_id: 't' } as never,
        't',
        { signal: new AbortController().signal },
      );
    expect(await hook('git reset --hard')).toEqual({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: 'Relay approval' },
    });
    expect(await hook('ls')).toEqual({});
    expect(asked).toEqual([['Bash', { command: 'git reset --hard' }], ['Bash', { command: 'ls' }]]);
  });

  it('asks the runtime which commands a directory offers, and shuts that query down again', async () => {
    let seen: Parameters<SdkQueryFn>[0] | null = null;
    let closed = 0;
    const fakeQuery = ((params: Parameters<SdkQueryFn>[0]) => {
      seen = params;
      async function* gen() {}
      const g = gen() as FakeGen;
      g.interrupt = async () => undefined;
      g.close = () => {
        closed += 1;
      };
      g.supportedCommands = async () => [{ name: 'review', description: 'Review', argumentHint: '[pr]' }];
      return g;
    }) as unknown as SdkQueryFn;
    const { commands } = await new SdkAgentClient(fakeQuery).describe('/repo');
    expect(commands).toEqual([{ name: 'review', description: 'Review', argumentHint: '[pr]' }]);
    expect(seen!.options).toMatchObject({ cwd: '/repo', settingSources: ['user', 'project', 'local'] });
    expect(closed).toBe(1);
  });

  it('maps an error result and a deny from canUseTool', async () => {
    let bridged: unknown = null;
    const fakeQuery = ((params: Parameters<SdkQueryFn>[0]) => {
      async function* gen() {
        const toolOpts = { signal: new AbortController().signal } as Parameters<NonNullable<Options['canUseTool']>>[2];
        bridged = await params.options!.canUseTool!('Bash', { command: 'git push -f' }, toolOpts);
        yield { type: 'result', subtype: 'error_during_execution', is_error: true, session_id: 's', errors: ['boom'] };
      }
      const g = gen() as FakeGen;
      g.interrupt = async () => undefined;
      return g;
    }) as unknown as SdkQueryFn;
    const run = new SdkAgentClient(fakeQuery).start({
      sessionId: 's', cwd: '/r', input: new AsyncQueue(), canUseTool: async () => ({ behavior: 'deny', message: 'no' }),
    });
    const msgs = await collect(run.messages);
    expect(bridged).toEqual({ behavior: 'deny', message: 'no' });
    expect(msgs).toEqual([
      { type: 'result', isError: true, aborted: false, error: 'error_during_execution: boom', queuedTurns: null, settledSendIds: [] },
    ]);
  });

  it("maps the send an assistant frame answers and flags subagent frames", async () => {
    const fakeQuery = (() => {
      async function* gen() {
        yield { type: "assistant", uuid: "a1", session_id: "s", parent_tool_use_id: null, user_message_uuid: "send-1",
          message: { role: "assistant", content: [{ type: "text", text: "main" }] } };
        yield { type: "assistant", uuid: "a2", session_id: "s", parent_tool_use_id: "tool-9",
          message: { role: "assistant", content: [{ type: "text", text: "sub" }] } };
        yield { type: "user", uuid: "u2", session_id: "s", parent_tool_use_id: "tool-9",
          message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "ok" }] } };
      }
      const g = gen() as FakeGen;
      g.interrupt = async () => undefined;
      return g;
    }) as unknown as SdkQueryFn;
    const run = new SdkAgentClient(fakeQuery).start({ sessionId: "s", cwd: "/r", input: new AsyncQueue(), canUseTool: async () => ({ behavior: "allow" }) });
    const msgs = await collect(run.messages);
    expect(msgs.map((m) => (m.type === "assistant" || m.type === "tool-results" ? [m.uuid, m.sendId, m.sidechain] : null))).toEqual([
      ["a1", "send-1", false],
      ["a2", null, true],
      ["u2", null, true],
    ]);
  });
  it('forks a session for a side question and keeps the fork off disk', () => {
    let seen: Parameters<SdkQueryFn>[0] | null = null;
    const fakeQuery = ((params: Parameters<SdkQueryFn>[0]) => {
      seen = params;
      async function* gen() {}
      const g = gen() as FakeGen;
      g.interrupt = async () => undefined;
      return g;
    }) as unknown as SdkQueryFn;
    new SdkAgentClient(fakeQuery).start({
      sessionId: 'abc', cwd: '/r', input: new AsyncQueue(), canUseTool: async () => ({ behavior: 'allow' }), fork: true, persist: false,
    });
    expect(seen!.options).toMatchObject({ resume: 'abc', forkSession: true, persistSession: false });
  });
  it('asks one throwaway run for both the commands and the models a directory offers', async () => {
    let closed = false;
    const fakeQuery = (() => {
      async function* gen() {}
      const g = gen() as FakeGen & { supportedCommands: () => Promise<unknown>; supportedModels: () => Promise<unknown>; close: () => void };
      g.interrupt = async () => undefined;
      g.supportedCommands = async () => [{ name: 'review', description: 'Review', argumentHint: '[pr]' }];
      g.supportedModels = async () => [
        { value: 'default', resolvedModel: 'claude-opus-5', displayName: 'Default (recommended)', description: 'Opus 5' },
        { value: 'sonnet', resolvedModel: 'claude-sonnet-5', displayName: 'Sonnet', description: 'Efficient' },
      ];
      g.close = () => { closed = true; };
      return g;
    }) as unknown as SdkQueryFn;
    const described = await new SdkAgentClient(fakeQuery).describe('/r');
    expect(described.commands).toEqual([{ name: 'review', description: 'Review', argumentHint: '[pr]' }]);
    expect(described.models).toEqual([
      { id: 'default', name: 'Default (recommended)', description: 'Opus 5', current: false },
      { id: 'sonnet', name: 'Sonnet', description: 'Efficient', current: false },
    ]);
    expect(closed).toBe(true);
  });

  it('starts a run on a chosen model and can switch a live one', async () => {
    let seen: Parameters<SdkQueryFn>[0] | null = null;
    const switched: (string | undefined)[] = [];
    const fakeQuery = ((params: Parameters<SdkQueryFn>[0]) => {
      seen = params;
      async function* gen() {}
      const g = gen() as FakeGen & { setModel: (m?: string) => Promise<void> };
      g.interrupt = async () => undefined;
      g.setModel = async (m) => { switched.push(m); };
      return g;
    }) as unknown as SdkQueryFn;
    const run = new SdkAgentClient(fakeQuery).start({
      sessionId: 'abc', cwd: '/r', input: new AsyncQueue(), canUseTool: async () => ({ behavior: 'allow' }), model: 'sonnet',
    });
    expect(seen!.options).toMatchObject({ model: 'sonnet' });
    await run.setModel?.('opus[1m]');
    expect(switched).toEqual(['opus[1m]']);
  });
});
