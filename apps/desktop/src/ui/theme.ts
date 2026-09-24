const KEY = 'relay.theme';

export type Theme = 'dark' | 'light';

/** What the system asks for right now. */
export function systemTheme(): Theme {
  try {
    return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

/**
 * The theme the user picked, or null while they have not picked one.
 *
 * Null matters: until there is a choice, the app follows the system and keeps following it
 * when the system changes. A choice pins it.
 */
export function loadTheme(): Theme | null {
  try {
    const saved = localStorage.getItem(KEY);
    return saved === 'dark' || saved === 'light' ? saved : null;
  } catch {
    return null;
  }
}

/** Puts the choice on the document, which is what the stylesheet keys off; null hands it back. */
export function applyTheme(theme: Theme | null): void {
  if (theme) document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
}

export function saveTheme(theme: Theme): void {
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    // storage may be unavailable; the theme still applies for this run
  }
}
