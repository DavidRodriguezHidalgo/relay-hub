import type { Invocable, MessageOrigin, ModelChoice, TranscriptBlock } from '@relay/shared';
import type { z, ZodRawShape } from 'zod';
import type { PermissionOutcome } from '../approvals/approval-queue';

export type AgentToolResult = { text: string; isError?: boolean };

/** A tool the agent can call that runs inside Relay's process. */
export interface AgentTool<Shape extends ZodRawShape = ZodRawShape> {
  name: string;
  description: string;
  input: Shape;
  handler: (args: z.infer<z.ZodObject<Shape>>) => Promise<AgentToolResult>;
}

/** `session` drives a user's session; `orchestrator` runs with Relay's tools only. */
export type AgentProfile =
  | { kind: 'session' }
  | { kind: 'orchestrator'; systemPrompt: string; tools: AgentTool[] };

export interface AgentInput {
  /** Relay's id for this send; the SDK echoes it back in the result that settles it. */
  id: string;
  text: string;
  /** `now` reaches a running turn (steer); `next` waits for the turn to end (queue). */
  priority: 'now' | 'next';
  origin: MessageOrigin;
}

export type AgentMessage =
  | { type: 'init'; sessionId: string; model?: string }
  | {
      type: 'assistant' | 'tool-results';
      uuid: string;
      timestamp: string;
      blocks: TranscriptBlock[];
      /** The send this frame answers, when the runtime stamps it (first frame of a turn, folds). */
      sendId: string | null;
      /** A subagent's frame, not the main thread. */
      sidechain: boolean;
    }
  | {
      /** One per turn, not per send: sends close together fold into one turn. */
      type: 'result';
      isError: boolean;
      /** The turn was interrupted: a normal end, but its work did not complete. */
      aborted: boolean;
      error: string | null;
      /** Turns the agent still has queued after this one, when the runtime reports it. */
      queuedTurns: number | null;
      /** Ids of the sends this turn consumed, when the runtime reports them. */
      settledSendIds: string[];
    };

export interface AgentRun {
  messages: AsyncIterable<AgentMessage>;
  interrupt(): Promise<void>;
  /** Switches the model mid-run, where the runtime allows it. */
  setModel?(model: string): Promise<void>;
}

/** What a directory offers: both come from one lookup, since asking costs a process. */
export interface AgentCapabilities {
  commands: Invocable[];
  models: ModelChoice[];
}

export type CanUseToolFn = (
  toolName: string,
  input: Record<string, unknown>,
  blockedPath: string | undefined,
  signal: AbortSignal,
) => Promise<PermissionOutcome>;

export interface AgentStartOptions {
  /** null starts a fresh session. */
  sessionId: string | null;
  cwd: string;
  input: AsyncIterable<AgentInput>;
  canUseTool: CanUseToolFn;
  /** Calls that must reach `canUseTool` even when the session's settings would pre-approve them. */
  needsApproval?: (toolName: string, input: Record<string, unknown>) => boolean;
  /** Start from a copy of the resumed session rather than continuing it. */
  fork?: boolean;
  /** Keep the run off disk; false for something that must leave no session behind. */
  persist?: boolean;
  /** Model to run on; omitted leaves the session's own choice alone. */
  model?: string;
  profile?: AgentProfile;
}

/** The only seam between Relay and the agent runtime; tests script it, production uses the SDK. */
export interface AgentClient {
  start(opts: AgentStartOptions): AgentRun;
  /** Commands and models a directory offers; absent when the runtime cannot say. */
  describe?(cwd: string): Promise<AgentCapabilities>;
}
