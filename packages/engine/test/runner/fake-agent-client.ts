import { AsyncQueue } from '../../src/runner/async-queue';
import type { AgentClient, AgentInput, AgentMessage, AgentRun, AgentStartOptions } from '../../src/runner/agent-client';

/**
 * A hand-driven agent that behaves like the SDK where it matters for state:
 * one `result` per turn (sends close together fold into one turn), and an
 * interrupt ends the current turn with a non-error result.
 */
export class FakeAgentClient implements AgentClient {
  starts: AgentStartOptions[] = [];
  received: AgentInput[] = [];
  out = new AsyncQueue<AgentMessage>();
  interrupts = 0;
  failWith: Error | null = null;
  lastOpts: AgentStartOptions | null = null;
  /** Ids of sends the fake has received and not yet settled with a result. */
  private unsettled: string[] = [];

  start(opts: AgentStartOptions): AgentRun {
    this.starts.push(opts);
    this.lastOpts = opts;
    const out = new AsyncQueue<AgentMessage>();
    this.out = out;
    // Like the SDK: once the input stream ends, the output generator completes.
    void (async () => {
      for await (const m of opts.input) {
        this.received.push(m);
        this.unsettled.push(m.id);
      }
      out.end();
    })();
    const self = this;
    async function* messages() {
      for await (const m of self.out) {
        if (self.failWith) throw self.failWith;
        yield m;
      }
    }
    return {
      messages: messages(),
      interrupt: async () => {
        self.interrupts += 1;
        self.result(null, 0);
      },
    };
  }

  /** Simulates the agent asking permission; resolves with the queue's decision. */
  askTool(toolName: string, input: Record<string, unknown>) {
    return this.lastOpts!.canUseTool(toolName, input, undefined, new AbortController().signal);
  }

  /** Calls a tool the orchestrator was started with, as the model would. */
  callTool(name: string, args: Record<string, unknown>) {
    const profile = this.lastOpts?.profile;
    if (profile?.kind !== 'orchestrator') throw new Error('not an orchestrator run');
    const t = profile.tools.find((x) => x.name === name);
    if (!t) throw new Error(`no tool ${name}`);
    return t.handler(args as never);
  }

  init(sessionId: string) {
    this.out.push({ type: 'init', sessionId });
  }

  assistant(uuid: string, text: string) {
    this.out.push({ type: 'assistant', uuid, timestamp: '2026-09-23T00:00:00.000Z', blocks: [{ kind: 'text', text }] });
  }

  /** Ends the current turn; every send received so far is settled unless `queuedTurns` says otherwise. */
  result(error: string | null = null, queuedTurns = 0, settledSendIds: string[] = this.unsettled) {
    this.unsettled = this.unsettled.filter((id) => !settledSendIds.includes(id));
    this.out.push({ type: 'result', isError: error !== null, error, queuedTurns, settledSendIds });
  }

  die(err: Error) {
    this.failWith = err;
    this.out.push({ type: 'result', isError: false, error: null, queuedTurns: 0, settledSendIds: [] }); // wake the consumer
  }
}

export const tick = () => new Promise((r) => setTimeout(r, 0));
