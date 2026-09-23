import { existsSync } from 'node:fs';
import { dirname, parse } from 'node:path';

const cache = new Map<string, string | null>();

/**
 * The git repository a path belongs to, or null when it is in none.
 *
 * Approvals are keyed on this so that allowing a project once covers every file in it,
 * instead of asking again for each folder the agent happens to touch next.
 */
export function repoRootOf(path: string, exists: (p: string) => boolean = existsSync): string | null {
  const cached = cache.get(path);
  if (cached !== undefined) return cached;
  const { root } = parse(path);
  let dir = path;
  let found: string | null = null;
  for (let hops = 0; hops < 64; hops += 1) {
    if (exists(`${dir}/.git`)) {
      found = dir;
      break;
    }
    const parent = dirname(dir);
    if (parent === dir || dir === root) break;
    dir = parent;
  }
  cache.set(path, found);
  return found;
}
