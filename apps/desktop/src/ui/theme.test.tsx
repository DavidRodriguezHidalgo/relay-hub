import { afterEach, describe, expect, it } from 'vitest';
import { applyTheme, loadTheme, saveTheme, systemTheme } from './theme';

describe('theme', () => {
  afterEach(() => {
    localStorage.clear();
    delete document.documentElement.dataset.theme;
  });

  it('has no choice of its own until one is made', () => {
    expect(loadTheme()).toBeNull();
    saveTheme('light');
    expect(loadTheme()).toBe('light');
  });

  it('ignores a stored value that means nothing', () => {
    localStorage.setItem('relay.theme', 'sepia');
    expect(loadTheme()).toBeNull();
  });

  it('leaves the document alone while the system decides, and marks it once chosen', () => {
    applyTheme(null);
    expect(document.documentElement.dataset.theme).toBeUndefined();
    applyTheme('light');
    expect(document.documentElement.dataset.theme).toBe('light');
    applyTheme(null);
    expect(document.documentElement.dataset.theme).toBeUndefined();
  });

  it('reports what the system asks for', () => {
    expect(systemTheme()).toBe('dark'); // jsdom reports no light preference
  });
});
