import { describe, expect, it, vi } from 'vitest';
import { releaseFocusBeforeReload, RELOAD_EVENTS } from './reloadGuard';

/** Stands in for Vite's `import.meta.hot`, which only exists in a development window. */
function fakeHot() {
  const handlers = new Map<string, () => void>();
  return {
    on: (event: string, cb: () => void) => handlers.set(event, cb),
    off: (event: string) => handlers.delete(event),
    emit: (event: string) => handlers.get(event)?.(),
    listening: () => [...handlers.keys()],
  };
}

describe('releaseFocusBeforeReload', () => {
  it('blurs the focused field before the page is replaced', () => {
    const hot = fakeHot();
    const box = document.createElement('textarea');
    document.body.append(box);
    box.focus();
    expect(document.activeElement).toBe(box);

    releaseFocusBeforeReload(hot);
    hot.emit('vite:beforeFullReload');

    expect(document.activeElement).not.toBe(box);
  });

  it('listens for every event that precedes the page going away', () => {
    const hot = fakeHot();
    releaseFocusBeforeReload(hot);
    expect(hot.listening().sort()).toEqual([...RELOAD_EVENTS].sort());
  });

  it('does nothing when there is no hot channel, as in a packaged build', () => {
    expect(() => releaseFocusBeforeReload(undefined)).not.toThrow();
  });

  it('survives an element that cannot be blurred', () => {
    const hot = fakeHot();
    const box = document.createElement('textarea');
    document.body.append(box);
    box.focus();
    vi.spyOn(box, 'blur').mockImplementation(() => {
      throw new Error('detached');
    });

    releaseFocusBeforeReload(hot);
    expect(() => hot.emit('vite:beforeFullReload')).not.toThrow();
  });

  it('stops listening once disposed, so a remounted window adds no duplicates', () => {
    const hot = fakeHot();
    const dispose = releaseFocusBeforeReload(hot);
    dispose();
    expect(hot.listening()).toEqual([]);
  });
});
