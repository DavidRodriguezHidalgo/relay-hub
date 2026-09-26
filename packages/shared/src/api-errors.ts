/**
 * What a person can do about a failure Claude Code reported in place of a reply.
 *
 * Keyed by the error code Claude Code attaches to the message, never by its wording: the text
 * is prose that can change, the code is the contract. An unknown code falls back to the text.
 */
const GUIDANCE: Record<string, string> = {
  authentication_failed:
    "Claude Code's login has expired. In a terminal run `claude`, then `/login`; then send again — Relay starts a fresh session that picks up the new login.",
};

export function explainApiError(code: string | undefined, text: string): string {
  return (code && GUIDANCE[code]) || text;
}

/** Whether Relay has something better to say than the raw message. */
export function hasGuidance(code: string | undefined): boolean {
  return Boolean(code && GUIDANCE[code]);
}
