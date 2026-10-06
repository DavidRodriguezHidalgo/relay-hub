import { z } from 'zod';
import type { BulkRun, DeliveryMode, PrWatch, RunState, SessionFailure, SessionSummary, TranscriptBlock, TranscriptEntry } from '@relay/shared';
import { FAILURE_MEANING } from '@relay/shared';
import type { AgentTool, AgentToolResult } from '../runner/agent-client';

/**
 * How much a tool may return.
 *
 * Whatever a tool returns joins the orchestrator's conversation and is read again on every
 * later turn, so a generous answer is paid for many times over. These are sized to answer the
 * usual question in one call: too small and the model asks twice, which costs far more.
 */
const LIST_MAX = 20;
const RECENT_MAX = 8;
const TEXT_MAX = 240;
const RESULT_MAX = 120;
const BLOCKS_MAX = 6;
const SUMMARY_MAX = 300;
/** Rows per side of a needs_attention answer; more than this is a queue to work through, not a status. */
const ATTENTION_MAX = 10;

export interface RelayToolDeps {
  listSessions(): SessionSummary[];
  runState(): RunState;
  /** The last failure of every session that has one, keyed by session id; survives its runner. */
  failures(): Record<string, SessionFailure>;
  getTranscript(id: string): Promise<TranscriptEntry[]>;
  send(req: { sessionId: string; prompt: string; mode: DeliveryMode; origin: 'orchestrator' }): Promise<string>;
  /** false when the session was not running. */
  interrupt(sessionId: string): Promise<boolean>;
  proposeBulk(targets: { sessionId: string; prompt: string }[], mode: DeliveryMode): Promise<BulkRun>;
  listPrs(): Promise<PrListing[]>;
  createWatch(sessionId: string): Promise<PrWatch>;
  /** By session id: stops that session's active watch. */
  deleteWatch(sessionId: string): Promise<void>;
  listProjects(): Promise<{ name: string; root: string; sessions: number }[]>;
  createSession(req: { project: string; branch?: string; prompt: string; inPlace?: boolean }): Promise<{ sessionId: string; cwd: string }>;
}

/** One of the user's open PRs, joined to the session working on its branch. */
export interface PrListing {
  repo: string;
  number: number;
  url: string;
  title: string;
  branch: string;
  sessionId: string | null;
  watched: boolean;
}

const ok = (value: unknown): AgentToolResult => ({ text: JSON.stringify(value) });
const fail = (err: unknown): AgentToolResult => ({
  text: err instanceof Error ? err.message : String(err),
  isError: true,
});
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);
const clipOrNull = (text: string | null) => (text === null ? null : clip(text, SUMMARY_MAX));

/**
 * A failure is dropped once the session has worked for this long after it.
 *
 * A record is only cleared by a later turn through Relay, so a session picked up in a terminal
 * would keep wearing an old failure. Transcript activity well after the failure says it has moved
 * on. The grace is there because the failing turn's own last message lands a moment before the
 * record is written, and that must not read as recovery.
 */
const RECOVERED_AFTER_MS = 60_000;

/**
 * The failure this session is still in, if any.
 *
 * A session that is running again is not reported as failed, however its last turn ended: the
 * record is kept so that stopping the retry does not erase it, but while the retry is in flight
 * the honest answer is that nothing has failed yet.
 */
function failureOf(s: SessionSummary, run: RunState, failures: Record<string, SessionFailure>): SessionFailure | null {
  const f = failures[s.id];
  if (!f) return null;
  if (run.states[s.id]?.state === 'running') return null;
  const moved = Date.parse(s.lastActivity) - Date.parse(f.at) > RECOVERED_AFTER_MS;
  return moved ? null : f;
}

/** Small enough to repeat once per listed session; describeFailure has already capped the message. */
const brief = (f: SessionFailure) => ({
  kind: f.kind,
  message: f.message,
  ...(f.resetsAt ? { resetsAt: f.resetsAt } : {}),
});

function row(s: SessionSummary, run: RunState, failures: Record<string, SessionFailure>) {
  const failure = failureOf(s, run, failures);
  return {
    id: s.id,
    repo: s.repo,
    branch: s.branch,
    title: s.title,
    // a failed session outlives its runner, so with no live state a recorded failure still rules
    state: run.states[s.id]?.state ?? (failure ? 'error' : 'idle'),
    lastActivity: s.lastActivity,
    prNumber: s.prNumber,
    pendingApprovals: run.approvals.filter((a) => a.sessionId === s.id).length,
    ...(failure ? { failure: brief(failure) } : {}),
    // not a fault, but sending to it will be refused until the user takes it over
    ...(run.external[s.id] ? { heldElsewhere: true } : {}),
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
        const failures = deps.failures();
        // Same matching as the sidebar's groupSessions (apps/desktop); duplicated because the engine cannot import the app.
        const rows = deps
          .listSessions()
          .filter(
            (s) =>
              (includeStale || !s.isStale) &&
              (q === '' || [s.title, s.branch ?? '', s.repo].some((f) => f.toLowerCase().includes(q))),
          )
          .sort((a, b) => b.lastActivity.localeCompare(a.lastActivity))
          .map((s) => row(s, run, failures));
        const shown = rows.slice(0, LIST_MAX);
        const more = rows.length - shown.length;
        return ok({
          sessions: shown,
          more,
          ...(more > 0 ? { hint: 'Narrow with query rather than asking for more.' } : {}),
        });
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
        const failures = deps.failures();
        const recent = (await deps.getTranscript(id))
          .filter((e) => !e.isMeta && !e.isSidechain)
          .slice(-RECENT_MAX)
          .map((e) => ({
            role: e.role,
            timestamp: e.timestamp,
            content: [
              ...e.blocks.slice(0, BLOCKS_MAX).map(compact).filter((c) => c !== null),
              ...(e.blocks.length > BLOCKS_MAX ? [{ more: e.blocks.length - BLOCKS_MAX }] : []),
            ],
          }));
        const failure = failureOf(session, run, failures);
        // the live error is usually the very text the record already carries, so it is only added
        // when it says something the failure does not
        const error = clipOrNull(run.states[id]?.error ?? null);
        return ok({
          session: {
            ...row(session, run, failures),
            cwd: session.cwd,
            ...(error && error !== failure?.message ? { error } : {}),
            // taken from the same failure the row reports, so a dropped one cannot leave its meaning behind
            ...(failure ? { means: FAILURE_MEANING[failure.kind] } : {}),
          },
          approvals: run.approvals
            .filter((a) => a.sessionId === id)
            .map((a) => ({ id: a.id, summary: clip(a.summary, SUMMARY_MAX), reason: a.reason })),
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
        const interrupted = await deps.interrupt(id);
        return ok(interrupted ? { interrupted: true } : { interrupted: false, note: 'That session was not running.' });
      } catch (err) {
        return fail(err);
      }
    },
  };

  const proposeBulk: AgentTool<{
    targets: z.ZodArray<z.ZodObject<{ id: z.ZodString; prompt: z.ZodOptional<z.ZodString> }>>;
    prompt: z.ZodString;
    mode: z.ZodOptional<z.ZodEnum<{ steer: 'steer'; queue: 'queue'; interrupt: 'interrupt' }>>;
  }> = {
    name: 'propose_bulk_action',
    description:
      'Propose one instruction for several sessions. The user sees a plan card, can untick rows, and must confirm; ' +
      'nothing runs before that. A "[bulk-end]" message arrives when all confirmed rows finish. ' +
      'A target may override the shared prompt.',
    input: {
      targets: z.array(z.object({ id: z.string(), prompt: z.string().optional() })).min(2),
      prompt: z.string(),
      mode: z.enum(['steer', 'queue', 'interrupt']).optional(),
    },
    handler: async ({ targets, prompt, mode }) => {
      try {
        const run = await deps.proposeBulk(
          targets.map((t) => ({ sessionId: t.id, prompt: t.prompt ?? prompt })),
          mode ?? 'steer',
        );
        return ok({
          bulkRunId: run.id,
          status: run.status,
          rows: run.rows.length,
          note: 'Waiting for the user to confirm the plan card. Do not send to these sessions yourself.',
        });
      } catch (err) {
        return fail(err);
      }
    },
  };

  const listPrs: AgentTool<Record<string, never>> = {
    name: 'list_prs',
    description: "The user's open pull requests, each with the session working on its branch (if any) and whether it is watched.",
    input: {},
    handler: async () => {
      try {
        return ok(await deps.listPrs());
      } catch (err) {
        return fail(err);
      }
    },
  };

  const createWatch: AgentTool<{ id: z.ZodString }> = {
    name: 'create_watch',
    description:
      "Watch the pull request of a session. Relay checks it every few minutes and wakes that session when CI fails, " +
      'someone reviews, or the PR falls behind or into conflict. You are not told about those wakes.',
    input: { id: z.string() },
    handler: async ({ id }) => {
      try {
        const w = await deps.createWatch(id);
        return ok({ watching: true, repo: w.repo, prNumber: w.prNumber, prUrl: w.prUrl });
      } catch (err) {
        return fail(err);
      }
    },
  };

  const deleteWatch: AgentTool<{ id: z.ZodString }> = {
    name: 'delete_watch',
    description: "Stop watching a session's pull request.",
    input: { id: z.string() },
    handler: async ({ id }) => {
      try {
        await deps.deleteWatch(id);
        return ok({ watching: false });
      } catch (err) {
        return fail(err);
      }
    },
  };

  const listProjects: AgentTool<Record<string, never>> = {
    name: 'list_projects',
    description: 'Repositories the user has sessions in: name, root path and how many sessions.',
    input: {},
    handler: async () => {
      try {
        return ok(await deps.listProjects());
      } catch (err) {
        return fail(err);
      }
    },
  };

  const createSession: AgentTool<{
    project: z.ZodString;
    branch: z.ZodOptional<z.ZodString>;
    prompt: z.ZodString;
    inPlace: z.ZodOptional<z.ZodBoolean>;
  }> = {
    name: 'create_session',
    description:
      'Start a new Claude session. project: a name from list_projects or an absolute directory. ' +
      'branch: the branch to create a fresh git worktree for (normal case; an existing origin branch is checked out). ' +
      'Without a branch, project must be the absolute path of an existing worktree: main checkouts are refused. ' +
      'inPlace: work in that directory as it stands, main checkout included, making no branch and no worktree. ' +
      'Only when the user has asked for it — two sessions editing one directory double-apply edits. ' +
      'prompt: its first instruction, complete on its own.',
    input: { project: z.string(), branch: z.string().optional(), prompt: z.string(), inPlace: z.boolean().optional() },
    handler: async ({ project, branch, prompt, inPlace }) => {
      try {
        const created = await deps.createSession({ project, ...(branch ? { branch } : {}), prompt, ...(inPlace ? { inPlace } : {}) });
        return ok({ created: true, ...created });
      } catch (err) {
        return fail(err);
      }
    },
  };

  const needsAttention: AgentTool<Record<string, never>> = {
    name: 'needs_attention',
    description:
      'Everything that is stuck right now, in one call: sessions whose last turn failed (with the kind of failure and ' +
      'what it means) and sessions waiting on an approval. Use this to answer "what is broken" rather than listing ' +
      'every session and reading each one.',
    input: {},
    handler: async () => {
      try {
        const run = deps.runState();
        const failures = deps.failures();
        const sessions = deps.listSessions();
        const named = (id: string) => sessions.find((s) => s.id === id);

        const broken = sessions
          // a session open in another Claude process is not this question's business: it cannot be
          // acted on from here until the user takes it over, and its row already says so
          .filter((s) => !s.isStale && !run.external[s.id])
          .map((s) => ({ s, f: failureOf(s, run, failures) }))
          .filter((r): r is { s: SessionSummary; f: SessionFailure } => r.f !== null)
          .sort((a, b) => b.f.at.localeCompare(a.f.at))
          .slice(0, ATTENTION_MAX);

        const failing = broken.map(({ s, f }) => ({
          id: s.id,
          title: s.title,
          repo: s.repo,
          ...brief(f),
          at: f.at,
        }));

        const waiting = run.approvals.slice(0, ATTENTION_MAX).map((a) => ({
          approvalId: a.id,
          sessionId: a.sessionId,
          title: named(a.sessionId)?.title ?? null,
          summary: clip(a.summary, SUMMARY_MAX),
          reason: a.reason,
        }));

        // one line per kind present, not per row: ten sessions on the same limit said it ten times
        const means = Object.fromEntries(
          [...new Set(broken.map(({ f }) => f.kind))].map((kind) => [kind, FAILURE_MEANING[kind]]),
        );

        return ok({
          failing,
          waiting,
          ...(failing.length > 0 ? { means } : {}),
          ...(failing.length === 0 && waiting.length === 0 ? { note: 'Nothing is failing or waiting.' } : {}),
        });
      } catch (err) {
        return fail(err);
      }
    },
  };

  return [
    listSessions,
    getSession,
    needsAttention,
    sendToSession,
    interruptSession,
    proposeBulk,
    listPrs,
    createWatch,
    deleteWatch,
    listProjects,
    createSession,
  ] as AgentTool[];
}
