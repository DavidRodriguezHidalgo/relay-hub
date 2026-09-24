import { useRef } from 'react';

/** How far one arrow-key press moves a divider. */
const STEP = 16;

interface Props {
  label: string;
  width: number;
  /** Which column the handle belongs to: dragging right widens a left one and narrows a right one. */
  side: 'left' | 'right';
  onResize: (width: number) => void;
}

/** The divider between two columns; drag it, or focus it and use the arrow keys. */
export function ColumnResizer({ label, width, side, onResize }: Props) {
  const from = useRef<{ x: number; width: number } | null>(null);
  const move = (dx: number, start: number) => onResize(start + (side === 'left' ? dx : -dx));
  return (
    <div
      className="resizer"
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      tabIndex={0}
      onPointerDown={(e) => {
        from.current = { x: e.clientX, width };
        e.currentTarget.setPointerCapture?.(e.pointerId);
      }}
      onPointerMove={(e) => {
        if (from.current) move(e.clientX - from.current.x, from.current.width);
      }}
      onPointerUp={(e) => {
        from.current = null;
        e.currentTarget.releasePointerCapture?.(e.pointerId);
      }}
      onKeyDown={(e) => {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
        e.preventDefault();
        move(e.key === 'ArrowRight' ? STEP : -STEP, width);
      }}
    />
  );
}
