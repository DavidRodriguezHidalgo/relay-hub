import type { ModelChoice } from '@relay/shared';

/** Models matching what has been typed, by id or name; prefix matches first, then the rest. */
export function matchModels(models: ModelChoice[], query: string): ModelChoice[] {
  const q = query.toLowerCase();
  if (!q) return models;
  const starts: ModelChoice[] = [];
  const rest: ModelChoice[] = [];
  for (const m of models) {
    const id = m.id.toLowerCase();
    const name = m.name.toLowerCase();
    if (id.startsWith(q) || name.startsWith(q)) starts.push(m);
    else if (id.includes(q) || name.includes(q)) rest.push(m);
  }
  return [...starts, ...rest];
}
