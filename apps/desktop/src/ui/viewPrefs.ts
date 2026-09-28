import { useState } from 'react';

/**
 * Small per-viewer choices, remembered between runs.
 *
 * A failure to read or write means the choice lasts for this window only, which is why every
 * path here swallows rather than throws: a view preference is never worth an error.
 */
export function readStored<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

export function writeStored(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // storage unavailable: the choice lasts for this window only
  }
}

/**
 * A yes-or-no view choice that outlives the window.
 *
 * Both lists in the left panel keep one of these, and kept them identically; this is the one
 * copy of reading it at mount and writing it back when it changes.
 */
export function useStoredFlag(key: string, fallback: boolean): [boolean, (on: boolean) => void] {
  const [value, setValue] = useState(() => readStored<boolean>(key, fallback));
  return [
    value,
    (on: boolean) => {
      setValue(on);
      writeStored(key, on);
    },
  ];
}
