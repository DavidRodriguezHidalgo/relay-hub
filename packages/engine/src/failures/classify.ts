import type { FailureKind, SessionFailure } from '@relay/shared';

/** Wordings a usage limit arrives with. Text is the only signal here; there is no code for it. */
const USAGE_LIMIT = /\b(usage limit|rate limit|rate.limited|quota|too many requests|429)\b/i;
/**
 * A time the limit lifts, when the message names one.
 *
 * The full timestamp is tried before the clock time, and the clock time refuses to stop in the
 * middle of a longer number. Read the other way round, `resets at 2026-09-30T18:00Z` reported that
 * the limit lifts at "20" — the first two digits of the year.
 */
const RESETS_AT =
  /\bresets?\s+(?:at\s+)?([0-9]{4}-[0-9]{2}-[0-9]{2}(?:T[0-9:.]+Z?)?|[0-9]{1,2}(?::[0-9]{2})?\s*(?:am|pm)?(?![0-9:-]))/i;

/**
 * Wording that says a tool the session ran failed.
 *
 * Deliberately narrow. `spawn`, `ENOENT` and `EACCES` were here and had to go: `spawn claude ENOENT`
 * is the runtime failing to start, and calling that "a tool the session ran failed" sends the reader
 * to look at the session instead of at their install.
 */
const TOOL_TROUBLE = /\b(tool|command|exit code)\b/i;

/**
 * Kinds carried by the code a failed run is reported under.
 *
 * The agent client puts the SDK's result subtype at the front of the message, so this reads a
 * code rather than prose. `error_max_turns` is deliberately absent: hitting the turn cap is not a
 * crash, and its own message already says what happened.
 */
const BY_SUBTYPE: Record<string, FailureKind> = { error_during_execution: 'crash' };

/**
 * Names the kind of failure, preferring what the runtime said over what the message reads like.
 *
 * Wording is the last resort, because it is the least reliable thing about an error. Anything
 * unrecognised stays `unknown` rather than being forced into a category that would misdirect.
 *
 * @param apiError the code Claude Code attached when the request itself failed.
 */
export function classifyFailure(message: string, apiError?: string): FailureKind {
  if (apiError === 'authentication_failed') return 'authentication';
  // the subtype is a code and beats wording: `error_during_execution: EDQUOT: disk quota exceeded`
  // is a crash that mentions a quota, not a usage limit that will clear on its own
  const subtype = message.split(':', 1)[0]!.trim();
  if (Object.hasOwn(BY_SUBTYPE, subtype)) return BY_SUBTYPE[subtype]!;
  if (USAGE_LIMIT.test(message)) return 'usage-limit';
  if (apiError) return 'crash';
  if (TOOL_TROUBLE.test(message)) return 'tool';
  return 'unknown';
}

/** When a usage limit says it lifts, or undefined when it does not say. */
export function resetsAt(message: string): string | undefined {
  return RESETS_AT.exec(message)?.[1]?.trim();
}

const MESSAGE_MAX = 160;

/** The whole record, trimmed to something that can sit in a listing without crowding it. */
export function describeFailure(message: string, at: string, apiError?: string): SessionFailure {
  const kind = classifyFailure(message, apiError);
  const trimmed = message.trim().replace(/\s+/g, ' ');
  const when = kind === 'usage-limit' ? resetsAt(message) : undefined;
  return {
    kind,
    message: trimmed.length > MESSAGE_MAX ? `${trimmed.slice(0, MESSAGE_MAX)}…` : trimmed,
    at,
    ...(when ? { resetsAt: when } : {}),
  };
}
