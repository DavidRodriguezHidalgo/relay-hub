import { afterEach, describe, expect, it } from 'vitest';
import { clampWidth, DEFAULT_WIDTHS, loadWidths, saveWidths } from './columnWidths';

describe('column widths', () => {
  afterEach(() => localStorage.clear());

  it('keeps each column within a usable range', () => {
    expect(clampWidth('left', 40)).toBe(220);
    expect(clampWidth('left', 5000)).toBe(560);
    expect(clampWidth('right', 400.4)).toBe(400);
  });

  it('remembers what was set last time', () => {
    saveWidths({ left: 420, right: 500 });
    expect(loadWidths()).toEqual({ left: 420, right: 500 });
  });

  it('falls back to the defaults when nothing is stored or it makes no sense', () => {
    expect(loadWidths()).toEqual(DEFAULT_WIDTHS);
    localStorage.setItem('relay.columnWidths', 'not json');
    expect(loadWidths()).toEqual(DEFAULT_WIDTHS);
    localStorage.setItem('relay.columnWidths', JSON.stringify({ left: 10, right: 99999 }));
    expect(loadWidths()).toEqual({ left: 220, right: 900 });
  });
});
