import { describe, expect, it } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useFollowBottom } from './useFollowBottom';

/** The hook only ever touches these three, so a plain object stands in for the container. */
const box = () => ({ scrollTop: 0, scrollHeight: 1000, clientHeight: 100 }) as HTMLElement;

describe('useFollowBottom', () => {
  it('puts you back where you were reading when you return to a session', () => {
    const el = box();
    const ref = { current: el };
    const { result, rerender } = renderHook(({ key }) => useFollowBottom(ref, [key], key), {
      initialProps: { key: 'a' },
    });
    expect(el.scrollTop).toBe(1000); // a new session opens at its latest turn

    el.scrollTop = 200; // the user scrolls up to read
    result.current();

    rerender({ key: 'b' }); // off to another session, which opens at its end
    expect(el.scrollTop).toBe(1000);

    rerender({ key: 'a' }); // and back
    expect(el.scrollTop).toBe(200);
  });

  it('keeps following a session that was left at the end', () => {
    const el = box();
    const ref = { current: el };
    const { result, rerender } = renderHook(({ key }) => useFollowBottom(ref, [key], key), {
      initialProps: { key: 'a' },
    });
    el.scrollTop = 900; // still within the follow threshold
    result.current();
    rerender({ key: 'b' });
    rerender({ key: 'a' });
    expect(el.scrollTop).toBe(1000);
  });
});
