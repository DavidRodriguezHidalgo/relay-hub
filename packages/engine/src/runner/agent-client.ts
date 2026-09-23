import type { MessageOrigin, TranscriptBlock } from '@relay/shared';
import type { PermissionOutcome } from '../approvals/approval-queue';

export interface AgentInput {
  /** Relay's id for this send; the SDK echoes it back in the result that settles it. */
  id: string;
  text: string;
  /** `now` reaches a running turn (steer); `next` waits for the turn to end (queue). */
  priority: 'now' | 'next';
  origin: MessageOrigin;
}

export type AgentMessage =
  | { type: 'init'; sessionId: string }
  | { type: 'assistant'; uuid: string; timestamp: string; blocks: TranscriptBlock[] }
  | { type: 'tool-results'; uuid: string; timestamp: string; blocks: TranscriptBlock[] }
  | {
      /** One per turn, not per send: sends close together fold into one turn. */
      type: 'result';
      isError: boolean;
      error: string | null;
      /** Turns the agent still has queued after this one, when the runtime reports it. */
      queuedTurns: number | null;
      /** Ids of the sends this turn consumed, when the runtime reports them. */
      settledSendIds: string[];
    };

export interface AgentRun {
  messages: AsyncIterable<AgentMessage>;
  interrupt(): Promise<void>;
}

export type CanUseToolFn = (
  toolName: string,
  input: Record<string, unknown>,
  blockedPath: string | undefined,
  signal: AbortSignal,
) => Promise<PermissionOutcome>;

export interface AgentStartOptions {
  sessionId: string;
  cwd: string;
  input: AsyncIterable<AgentInput>;
  canUseTool: CanUseToolFn;
}

/** The only seam between Relay and the agent runtime; tests script it, production uses the SDK. */
export interface AgentClient {
  start(opts: AgentStartOptions): AgentRun;
}
