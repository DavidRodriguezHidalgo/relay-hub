import { useEffect, useRef, type DependencyList, type RefObject } from 'react';

/** How close to the bottom (px) still counts as "following". */
const FOLLOW_THRESHOLD = 40;

/**
 * Keeps a scroll container pinned to its bottom when `deps` change, unless the user
 * scrolled up. `resetKey` changing (e.g. a newly opened session) re-pins it.
 */
export function useFollowBottom<T extends HTMLElement>(
  ref: RefObject<T | null>,
  deps: DependencyList,
  resetKey?: unknown,
): () => void {
  const follow = useRef(true);

  useEffect(() => {
    follow.current = true;
  }, [resetKey]);

  useEffect(() => {
    const el = ref.current;
    if (el && follow.current) el.scrollTop = el.scrollHeight;
  }, deps);

  return () => {
    const el = ref.current;
    if (!el) return;
    follow.current = el.scrollHeight - el.scrollTop - el.clientHeight <= FOLLOW_THRESHOLD;
  };
}
