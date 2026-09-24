import { useEffect, useRef, type DependencyList, type RefObject } from 'react';

/** How close to the bottom (px) still counts as "following". */
const FOLLOW_THRESHOLD = 40;

/**
 * Keeps a scroll container pinned to its bottom when `deps` change, unless the user
 * scrolled up.
 *
 * Where you were reading is kept per `resetKey`, so leaving a session and coming back
 * puts you where you left off rather than at the end. A session not seen before starts
 * pinned to its bottom, as does one you were already reading at the end of.
 */
export function useFollowBottom<T extends HTMLElement>(
  ref: RefObject<T | null>,
  deps: DependencyList,
  resetKey?: unknown,
): () => void {
  const follow = useRef(true);
  const seen = useRef(new Map<string, number>());
  const leaving = useRef(resetKey);
  /** Applied once the new content is in place, not while the old is still on screen. */
  const restore = useRef<number | null>(null);

  useEffect(() => {
    const el = ref.current;
    const left = leaving.current;
    if (el && left !== undefined && !follow.current) seen.current.set(String(left), el.scrollTop);
    else if (left !== undefined) seen.current.delete(String(left));
    leaving.current = resetKey;
    const where = resetKey === undefined ? undefined : seen.current.get(String(resetKey));
    follow.current = where === undefined;
    restore.current = where ?? null;
  }, [resetKey]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (restore.current !== null) {
      el.scrollTop = restore.current;
      restore.current = null;
      return;
    }
    if (follow.current) el.scrollTop = el.scrollHeight;
  }, deps);

  return () => {
    const el = ref.current;
    if (!el) return;
    follow.current = el.scrollHeight - el.scrollTop - el.clientHeight <= FOLLOW_THRESHOLD;
  };
}
