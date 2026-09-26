/** Which model a session runs on, and how that is known. */
export interface ModelInEffect {
  id: string;
  /**
   * `chosen` when a model was set for this session and is what its next run will use.
   * `last-run` when nothing was set and this is what its most recent request actually used.
   */
  source: 'chosen' | 'last-run';
}

/**
 * The model in effect for a session.
 *
 * A model set for this session wins, because that is what its next run will use. Otherwise the
 * answer is what the last request actually ran on, read from the session's own transcript.
 * With neither, the model is genuinely not known yet and this says so by returning null rather
 * than naming whatever the default happens to be.
 */
export function modelInEffect(chosen: string | null, lastRun: string | null): ModelInEffect | null {
  if (chosen) return { id: chosen, source: 'chosen' };
  if (lastRun) return { id: lastRun, source: 'last-run' };
  return null;
}

/**
 * A model id as a person would say it: `claude-sonnet-4-5` reads as `Sonnet 4.5`.
 *
 * An id that does not follow that shape is returned as it is. Inventing a tidier name for
 * something unrecognised would be worse than showing exactly what is set.
 */
export function modelLabel(id: string): string {
  const bare = id.replace(/^claude-/, '');
  const suffix = bare.match(/\[[^\]]+\]$/)?.[0] ?? '';
  const parts = bare.slice(0, bare.length - suffix.length).split('-').filter(Boolean);
  const [family, ...rest] = parts;
  if (!family || rest.some((p) => !/^\d+$/.test(p))) return id;
  const name = family.charAt(0).toUpperCase() + family.slice(1);
  const version = rest.join('.');
  return [version ? `${name} ${version}` : name, suffix].filter(Boolean).join(' ');
}
