import { z } from 'zod';
import type { DeliveryMode, RunState, SessionSummary, TranscriptBlock, TranscriptEntry } from '@relay/shared';
import type { AgentTool, AgentToolResult } from '../runner/agent-client';

const LIST_MAX = 50;
const RECENT_MAX = 20;
const TEXT_MAX = 400;
const RESULT_MAX = 200;

export interface RelayToolDeps {
  listSessions(): SessionSummary[];
  runState(): RunState;
  getTranscript(id: string): Promise<TranscriptEntry[]>;
  send(req: { sessionId: string; prompt: string; mode: DeliveryMode; origin: 'orchestrator' }): Promise<string>;
  interrupt(sessionId: string): Promise<void>;
}

const ok = (value: unknown): AgentToolResult => ({ text: JSON.stringify(value) });
const fail = (err: unknown): AgentToolResult => ({
  text: err instanceof Error ? err.message : String(err),
  isError: true,
});
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);

function row(s: SessionSummary, run: RunState) {
  return {
    id: s.id,
    repo: s.repo,
    branch: s.branch,
    title: s.title,
    state: run.states[s.id]?.state ?? 'idle',
    lastActivity: s.lastActivity,
    prNumber: s.prNumber,
    pendingApprovals: run.approvals.filter((a) => a.sessionId === s.id).length,
  };
}

function compact(block: TranscriptBlock): unknown {
  switch (block.kind) {
    case 'text':
      return clip(block.text, TEXT_MAX);
    case 'tool_use':
      return { tool: block.name };
    case 'tool_result':
      return { result: clip(block.text, RESULT_MAX) };
    default:
      return null;
  }
}

/** The orchestrator's whole world: read sessions, send to one, interrupt one. */
export function createRelayTools(deps: RelayToolDeps): AgentTool[] {
  const find = (id: string) => deps.listSessions().find((s) => s.id === id);

  const listSessions: AgentTool<{ query: z.ZodOptional<z.ZodString>; includeStale: z.ZodOptional<z.ZodBoolean> }> = {
    name: 'list_sessions',
    description:
      'List Claude Code sessions on this machine, newest first. Optional case-insensitive query over title, branch and repo.',
    input: { query: z.string().optional(), includeStale: z.boolean().optional() },
    handler: async ({ query, includeStale }) => {
      try {
        const q = (query ?? '').trim().toLowerCase();
        const run = deps.runState();
        // Same matching as the sidebar's groupSessions (apps/desktop); duplicated because the engine cannot import the app.
        const rows = deps
          .listSessions()
          .filter(
            (s) =>
              (includeStale || !s.isStale) &&
              (q === '' || [s.title, s.branch ?? '', s.repo].some((f) => f.toLowerCase().includes(q))),
          )
          .sort((a, b) => b.lastActivity.localeCompare(a.lastActivity))
          .slice(0, LIST_MAX)
          .map((s) => row(s, run));
        return ok(rows);
      } catch (err) {
        return fail(err);
      }
    },
  };

  const getSession: AgentTool<{ id: z.ZodString }> = {
    name: 'get_session',
    description: 'Details of one session: summary, run state, pending approvals and its most recent turns (truncated).',
    input: { id: z.string() },
    handler: async ({ id }) => {
      try {
        const session = find(id);
        if (!session) return fail(new Error(`Unknown session ${id}`));
        const run = deps.runState();
        const recent = (await deps.getTranscript(id))
          .filter((e) => !e.isMeta && !e.isSidechain)
          .slice(-RECENT_MAX)
          .map((e) => ({
            role: e.role,
            timestamp: e.timestamp,
            content: e.blocks.map(compact).filter((c) => c !== null),
          }));
        return ok({
          session: { ...row(session, run), cwd: session.cwd, error: run.states[id]?.error ?? null },
          approvals: run.approvals.filter((a) => a.sessionId === id).map((a) => ({ id: a.id, summary: a.summary, reason: a.reason })),
          recent,
        });
      } catch (err) {
        return fail(err);
      }
    },
  };

  const sendToSession: AgentTool<{
    id: z.ZodString;
    prompt: z.ZodString;
    mode: z.ZodOptional<z.ZodEnum<{ steer: 'steer'; queue: 'queue'; interrupt: 'interrupt' }>>;
  }> = {
    name: 'send_to_session',
    description:
      'Send one instruction to one session. Returns at once; a "[turn-end]" message arrives when the session finishes. ' +
      'mode: steer (default, reaches a running turn), queue (after the current turn), interrupt (stop it, then send).',
    input: { id: z.string(), prompt: z.string(), mode: z.enum(['steer', 'queue', 'interrupt']).optional() },
    handler: async ({ id, prompt, mode }) => {
      try {
        const messageId = await deps.send({ sessionId: id, prompt, mode: mode ?? 'steer', origin: 'orchestrator' });
        return ok({ sent: true, messageId, note: 'You will get a turn-end message when it finishes.' });
      } catch (err) {
        return fail(err);
      }
    },
  };

  const interruptSession: AgentTool<{ id: z.ZodString }> = {
    name: 'interrupt_session',
    description: 'Stop the current turn of one session.',
    input: { id: z.string() },
    handler: async ({ id }) => {
      try {
        await deps.interrupt(id);
        return ok({ interrupted: true });
      } catch (err) {
        return fail(err);
      }
    },
  };

  return [listSessions, getSession, sendToSession, interruptSession] as AgentTool[];
}
