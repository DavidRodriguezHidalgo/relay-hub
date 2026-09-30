import type { FailureKind, SessionFailure } from '@relay/shared';

/** Wordings a usage limit arrives with. Text is the only signal here; there is no code for it. */
const USAGE_LIMIT = /\b(usage limit|rate limit|rate.limited|quota|too many requests|429)\b/i;
/** A time the limit lifts, when the message names one. */
const RESETS_AT = /\bresets?\s+(?:at\s+)?([0-9]{1,2}(?::[0-9]{2})?\s*(?:am|pm)?|[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z?)/i;
const TOOL_TROUBLE = /\b(tool|command|exit code|ENOENT|EACCES|spawn)\b/i;

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
  // before the subtype, so a limit reported through a failed run is still named a limit
  if (USAGE_LIMIT.test(message)) return 'usage-limit';
  const bySubtype = BY_SUBTYPE[message.split(':', 1)[0]!.trim()];
  if (bySubtype) return bySubtype;
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
