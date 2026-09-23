// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const css = readFileSync(fileURLToPath(new URL('./theme.css', import.meta.url)), 'utf8');

/** `--name: #rrggbb;` pairs inside the first block that follows `marker`. */
function tokens(marker: string): Record<string, string> {
  const start = css.indexOf(marker);
  if (start < 0) throw new Error(`no ${marker} block`);
  const block = css.slice(css.indexOf('{', start) + 1, css.indexOf('}', start));
  return Object.fromEntries([...block.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-fA-F]{6})/g)].map((m) => [m[1]!, m[2]!]));
}

const channel = (v: number) => {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
const luminance = (hex: string) => {
  const n = parseInt(hex.slice(1), 16);
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
};
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
};

/** Every foreground actually used on each background it sits on. */
const PAIRS: [fg: string, bg: string][] = [
  ...['text', 'muted', 'accent-text', 'running', 'waiting', 'danger', 'success'].flatMap((fg) =>
    ['bg', 'surface', 'surface-2'].map((bg) => [fg, bg] as [string, string]),
  ),
  ['on-accent', 'accent'],
];

describe.each([
  ['dark', ':root'],
  ['light', '@media (prefers-color-scheme: light)'],
])('%s theme', (_name, marker) => {
  const t = tokens(marker);
  it.each(['bg', 'surface', 'surface-2'])('the focus ring is visible on %s (3:1, non-text)', (bg) => {
    expect(t['focus'], 'missing --focus').toBeDefined();
    expect(contrast(t['focus']!, t[bg]!)).toBeGreaterThanOrEqual(3);
  });

  it.each(PAIRS)('%s on %s reaches WCAG AA (4.5:1)', (fg, bg) => {
    expect(t[fg], `missing --${fg}`).toBeDefined();
    expect(t[bg], `missing --${bg}`).toBeDefined();
    expect(contrast(t[fg]!, t[bg]!)).toBeGreaterThanOrEqual(4.5);
  });
});

describe('app.css', () => {
  const app = readFileSync(fileURLToPath(new URL('./app.css', import.meta.url)), 'utf8');
  it('never dims text with opacity (it would undercut the contrast checked above), except disabled controls', () => {
    const dimmed = app.split('\n').filter((l) => /opacity-\d/.test(l) && !l.includes('disabled:'));
    expect(dimmed).toEqual([]);
  });
  it('draws focus with the focus token, never the raw accent', () => {
    expect(app).not.toMatch(/focus[^;]*\b(outline|border)-accent(?![-\w])/);
  });
});
