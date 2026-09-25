import type { ContextUse } from '@relay/shared';

/** Above this, the session is close enough to full that it is worth knowing before you send more. */
const NEARLY_FULL = 85;

/**
 * How full a session's context is, said quietly.
 *
 * The tokens are the model's own count, but the window is inferred from the model name and a
 * compacted session reads fuller than it is — so the number is always shown as approximate
 * rather than as a figure Relay cannot stand behind.
 */
export function ContextMeter({ use }: { use: ContextUse | null }) {
  if (!use) return null;
  const full = use.percent >= NEARLY_FULL;
  return (
    <span
      className={full ? 'context context--full' : 'context'}
      title={`Approximate: ${use.tokens.toLocaleString()} of ${use.limit.toLocaleString()} tokens at the last request${use.model ? `, on ${use.model}` : ''}. Compacting resets it.`}
    >
      ~{use.percent}% context
    </span>
  );
}
