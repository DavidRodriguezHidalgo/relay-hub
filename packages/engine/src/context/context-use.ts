import type { ContextUse } from '@relay/shared';

/** What a Claude context window holds when nothing better is known. */
export const DEFAULT_CONTEXT_LIMIT = 200_000;

/** Models whose window is not the usual one, matched on a fragment of the name. */
const WIDER_WINDOWS: { fragment: string; limit: number }[] = [{ fragment: '1m', limit: 1_000_000 }];

export function limitFor(model: string | null): number {
  const name = (model ?? '').toLowerCase();
  return WIDER_WINDOWS.find((w) => name.includes(w.fragment))?.limit ?? DEFAULT_CONTEXT_LIMIT;
}

interface Usage {
  input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

/**
 * What the request carried: fresh input plus everything read from or written to the cache.
 *
 * The reply is left out. It is what was *sent* that filled the window, and counting the answer
 * too would overstate how full the session is.
 */
function tokensOf(usage: Usage): number {
  return (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);
}

function usageIn(record: unknown): { usage: Usage; model: string | null; at: string | null } | null {
  if (typeof record !== 'object' || record === null) return null;
  const message = (record as { message?: unknown }).message;
  if (typeof message !== 'object' || message === null) return null;
  const usage = (message as { usage?: unknown }).usage;
  if (typeof usage !== 'object' || usage === null) return null;
  return {
    usage: usage as Usage,
    model: (message as { model?: string }).model ?? null,
    at: (record as { timestamp?: string }).timestamp ?? null,
  };
}

/**
 * How full the context was at this session's most recent request.
 *
 * Returns null for a session that has never called the model, rather than a confident zero.
 */
export function contextUseFrom(records: unknown[]): ContextUse | null {
  for (let i = records.length - 1; i >= 0; i--) {
    const found = usageIn(records[i]);
    if (!found) continue;
    const tokens = tokensOf(found.usage);
    const limit = limitFor(found.model);
    return {
      tokens,
      limit,
      percent: Math.min(100, Math.round((tokens / limit) * 100)),
      model: found.model,
      at: found.at,
    };
  }
  return null;
}
