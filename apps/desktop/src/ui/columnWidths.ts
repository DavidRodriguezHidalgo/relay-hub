const KEY = 'relay.columnWidths';

export interface ColumnWidths {
  left: number;
  right: number;
}

export const DEFAULT_WIDTHS: ColumnWidths = { left: 300, right: 440 };

/** Each side keeps enough room to be usable, and leaves the middle column room to exist. */
const LIMITS: Record<keyof ColumnWidths, { min: number; max: number }> = {
  left: { min: 220, max: 560 },
  right: { min: 320, max: 900 },
};

export function clampWidth(side: keyof ColumnWidths, px: number): number {
  const { min, max } = LIMITS[side];
  return Math.round(Math.min(max, Math.max(min, px)));
}

/** Widths from the last session; anything unreadable or out of range falls back to the defaults. */
export function loadWidths(): ColumnWidths {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULT_WIDTHS;
    const saved = JSON.parse(raw) as Partial<ColumnWidths>;
    return {
      left: clampWidth('left', typeof saved.left === 'number' ? saved.left : DEFAULT_WIDTHS.left),
      right: clampWidth('right', typeof saved.right === 'number' ? saved.right : DEFAULT_WIDTHS.right),
    };
  } catch {
    return DEFAULT_WIDTHS;
  }
}

export function saveWidths(widths: ColumnWidths): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(widths));
  } catch {
    // a viewer with storage blocked simply does not keep them
  }
}
