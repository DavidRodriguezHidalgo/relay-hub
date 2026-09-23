import { AsyncQueue } from '../../src/runner/async-queue';
import type { AgentClient, AgentInput, AgentMessage, AgentRun, AgentStartOptions } from '../../src/runner/agent-client';

/** A hand-driven agent: the test pushes messages, reads what was sent, and can fail the run. */
export class FakeAgentClient implements AgentClient {
  starts: AgentStartOptions[] = [];
  received: AgentInput[] = [];
  out = new AsyncQueue<AgentMessage>();
  interrupts = 0;
  failWith: Error | null = null;
  lastOpts: AgentStartOptions | null = null;

  start(opts: AgentStartOptions): AgentRun {
    this.starts.push(opts);
    this.lastOpts = opts;
    const out = new AsyncQueue<AgentMessage>();
    this.out = out;
    // Like the SDK: once the input stream ends, the output generator completes.
    void (async () => {
      for await (const m of opts.input) this.received.push(m);
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
      },
    };
  }

  /** Simulates the agent asking permission; resolves with the queue's decision. */
  askTool(toolName: string, input: Record<string, unknown>) {
    return this.lastOpts!.canUseTool(toolName, input, undefined, new AbortController().signal);
  }

  assistant(uuid: string, text: string) {
    this.out.push({ type: 'assistant', uuid, timestamp: '2026-09-23T00:00:00.000Z', blocks: [{ kind: 'text', text }] });
  }

  result(error: string | null = null) {
    this.out.push({ type: 'result', isError: error !== null, error });
  }

  die(err: Error) {
    this.failWith = err;
    this.out.push({ type: 'result', isError: false, error: null }); // wake the consumer
  }
}

export const tick = () => new Promise((r) => setTimeout(r, 0));
