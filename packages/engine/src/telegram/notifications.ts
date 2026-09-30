import { ORCHESTRATOR_KEY, type BulkRun, type MessageOrigin, type PendingApproval, type RunnerEvent, type SessionState } from '@relay/shared';
import type { PhoneVerdict } from './approval-policy';

/** Enough of a last reply to know how it went; the app has the rest. */
const REPLY_MAX = 300;
/** A command is shown whole unless it is absurd; the message must fit Telegram's 4096. */
const COMMAND_MAX = 1500;

export interface SessionNames {
  session(id: string): { title: string; branch: string | null } | null;
}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);

/** "Title (branch)" or the id when the session is not known. */
function label(id: string, ctx: SessionNames): string {
  const s = ctx.session(id);
  if (!s) return id;
  return s.branch ? `${s.title} (${s.branch})` : s.title;
}

/** Turns you asked for from the phone, or delegated through the orchestrator: those you want to hear about. */
const delegated = (origins: MessageOrigin[]) => origins.some((o) => o === 'telegram' || o === 'orchestrator');

/**
 * The phone message for an event, or null for the many events that deserve none.
 *
 * Approvals are not here: they carry buttons, so the bridge builds them with `approvalMessage`.
 * The orchestrator's own turn ends are not here either: those are replies, not notifications.
 */
export function notificationFor(event: RunnerEvent, ctx: SessionNames): string | null {
  switch (event.type) {
    case 'turn-end': {
      if (event.sessionId === ORCHESTRATOR_KEY || !delegated(event.origins)) return null;
      const who = label(event.sessionId, ctx);
      if (event.error) return `✖ ${who} failed: ${clip(event.error, REPLY_MAX)}`;
      const reply = event.lastText ? clip(event.lastText, REPLY_MAX) : '(no reply)';
      return event.aborted ? `■ ${who} was stopped.\n\n${reply}` : `✔ ${who} finished.\n\n${reply}`;
    }
    case 'state':
      if (event.state !== 'error' || event.sessionId === ORCHESTRATOR_KEY) return null;
      return `✖ ${label(event.sessionId, ctx)} hit an error: ${clip(event.error ?? 'unknown error', REPLY_MAX)}`;
    case 'bulk':
      return bulkMessage(event.run);
    default:
      return null;
  }
}

function bulkMessage(run: BulkRun): string | null {
  if (run.status === 'proposed') {
    return `Relay proposed a bulk run for ${run.rows.length} sessions. It waits for you to confirm the plan in the app.`;
  }
  if (run.status !== 'finished') return null;
  const count = (s: string) => run.rows.filter((r) => r.status === s).length;
  const failed = run.rows.filter((r) => r.status === 'error').map((r) => `✖ ${r.title}: ${clip(r.detail ?? 'failed', REPLY_MAX)}`);
  return [`Bulk run finished: ${count('done')} done, ${count('error')} error, ${count('skipped')} skipped.`, ...failed].join('\n');
}

/** The text above an approval's buttons: who wants what, and why the phone may not say yes. */
export function approvalMessage(approval: PendingApproval, verdict: PhoneVerdict, ctx: SessionNames): string {
  const lines = [`${label(approval.sessionId, ctx)} wants to run:`, '', clip(approval.summary, COMMAND_MAX)];
  if (!verdict.allowOnce) lines.push('', `Allowing this needs the machine: ${verdict.why}.`);
  return lines.join('\n');
}

export interface StatusInput {
  sessions: { id: string; title: string; branch: string | null }[];
  states: Record<string, { state: SessionState; error: string | null }>;
  approvals: number;
  orchestrator: SessionState;
  bulkRunning: { done: number; total: number } | null;
}

/** `/status`, answered by Relay itself: what is running, waiting and broken, in a few lines. */
export function statusMessage(input: StatusInput): string {
  const name = (id: string) => label(id, { session: (x) => input.sessions.find((s) => s.id === x) ?? null });
  const lines: string[] = [];
  for (const [id, { state, error }] of Object.entries(input.states)) {
    if (id === ORCHESTRATOR_KEY) continue;
    if (state === 'running') lines.push(`Running: ${name(id)}`);
    else if (state === 'waiting-approval') lines.push(`Waiting for approval: ${name(id)}`);
    else if (state === 'error') lines.push(`Error: ${name(id)} — ${clip(error ?? 'unknown error', REPLY_MAX)}`);
  }
  if (input.bulkRunning) lines.push(`Bulk run in progress: ${input.bulkRunning.done} of ${input.bulkRunning.total} done.`);
  if (input.approvals > 0) lines.push(`${input.approvals} approval${input.approvals === 1 ? '' : 's'} waiting on you.`);
  if (input.orchestrator === 'running' || input.orchestrator === 'waiting-approval') lines.push('Relay chat is working on something.');
  return lines.length > 0 ? lines.join('\n') : 'Nothing is running.';
}
