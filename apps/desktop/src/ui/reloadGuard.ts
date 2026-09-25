/** Vite's hot channel, narrowed to what this guard uses so it can be supplied in a test. */
export interface ReloadChannel {
  on(event: string, cb: () => void): void;
  off(event: string, cb: () => void): void;
}

/** The moments at which Vite is about to take the current page away. */
export const RELOAD_EVENTS = ['vite:beforeFullReload', 'vite:invalidate'] as const;

/**
 * Lets go of the focused field just before a development reload replaces the page.
 *
 * macOS hands a keystroke to AppKit's key binding manager, which calls back into the web
 * contents view to flush the text it has pending. A full reload replaces that view. When the
 * reload lands between those two steps the callback reaches a view that is going away, and the
 * browser process stops on a trap that no JavaScript can catch. Dropping focus first means
 * there is no pending text for AppKit to flush at the moment the view is swapped.
 *
 * Only a development window has a hot channel, so this does nothing in a packaged build.
 *
 * @returns a disposer that stops listening.
 */
export function releaseFocusBeforeReload(hot: ReloadChannel | undefined, doc: Document = document): () => void {
  if (!hot) return () => undefined;
  const release = () => {
    const focused = doc.activeElement;
    try {
      if (focused instanceof HTMLElement) focused.blur();
    } catch {
      // the element is already detached: there is nothing left holding focus, which is the point
    }
  };
  for (const event of RELOAD_EVENTS) hot.on(event, release);
  return () => {
    for (const event of RELOAD_EVENTS) hot.off(event, release);
  };
}
