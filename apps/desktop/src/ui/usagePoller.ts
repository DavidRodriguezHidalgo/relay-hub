/**
 * Keeps a value fresh in the background, and gives up if the source cannot answer.
 *
 * Written for the usage reading, which is polled on a timer and whenever the window regains focus.
 * The giving-up matters: a window whose main process is older than it — the ordinary case while
 * developing, since the renderer reloads and the process does not — has no handler for a newly
 * added channel, and every single attempt logs an error in the process. One failure is a fact
 * worth reporting; several hundred is noise that buries everything else.
 *
 * Recovery is deliberate rather than automatic: the detail view has a button that reads again.
 */
export interface UsagePollOptions<T> {
  read: () => Promise<T>;
  onValue: (value: T) => void;
  /** Called the first time a read fails, so the window can stop expecting a value. */
  onGiveUp?: (reason: unknown) => void;
  intervalMs: number;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
  addFocusListener?: (fn: () => void) => void;
  removeFocusListener?: (fn: () => void) => void;
}

export function pollUsage<T>(opts: UsagePollOptions<T>): () => void {
  const setTimer = opts.setInterval ?? ((fn, ms) => globalThis.setInterval(fn, ms));
  const clearTimer = opts.clearInterval ?? ((h) => globalThis.clearInterval(h as number));
  const listen = opts.addFocusListener ?? ((fn) => globalThis.addEventListener?.('focus', fn));
  const unlisten = opts.removeFocusListener ?? ((fn) => globalThis.removeEventListener?.('focus', fn));

  let stopped = false;
  const read = () => {
    if (stopped) return;
    void opts.read().then(
      (value) => {
        if (!stopped) opts.onValue(value);
      },
      (reason: unknown) => {
        if (stopped) return;
        stop();
        opts.onGiveUp?.(reason);
      },
    );
  };

  const handle = setTimer(read, opts.intervalMs);
  listen(read);
  function stop() {
    if (stopped) return;
    stopped = true;
    clearTimer(handle);
    unlisten(read);
  }

  read();
  return stop;
}
