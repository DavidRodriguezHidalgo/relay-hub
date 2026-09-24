const KEY = 'relay.dismissedCollisions';

/** Clashes the user has waved away. Kept per clash, so a new one is still raised. */
export const dismissedCollisions = ((): string[] => {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '[]') as unknown;
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
})();

/** The most recent are worth keeping; older ones are of no interest once the work has moved on. */
const KEPT = 50;

export function dismissCollision(key: string): string[] {
  const next = [key, ...dismissedCollisions.filter((k) => k !== key)].slice(0, KEPT);
  dismissedCollisions.length = 0;
  dismissedCollisions.push(...next);
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // storage may be unavailable; the dismissal still holds for this run
  }
  return [...next];
}
