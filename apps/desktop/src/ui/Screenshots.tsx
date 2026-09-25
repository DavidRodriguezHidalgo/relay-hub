import { useState } from 'react';
import type { Screenshot } from '@relay/shared';

/**
 * Images the session produced while working.
 *
 * The chat is what this panel is for, so this stays a single line until it is asked for: a
 * permanent strip of thumbnails would take room from the conversation every turn to show
 * something worth looking at once.
 *
 * Relay does not take these; they are files the agent wrote, which is why each says what made it.
 */
export function Screenshots({ shots }: { shots: Screenshot[] }) {
  const [open, setOpen] = useState(false);
  if (shots.length === 0) return null;
  return (
    <section className="shots" aria-label="Screenshots">
      <button type="button" className="shots__toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        {shots.length} image{shots.length === 1 ? '' : 's'} produced
        <span className="shots__caret" aria-hidden="true">
          {open ? '▾' : '▸'}
        </span>
      </button>
      {open && (
        <div className="shots__strip">
          {shots.map((shot) => (
            <figure key={shot.path} className="shots__item">
              {shot.dataUrl ? (
                <img src={shot.dataUrl} alt={shot.name} />
              ) : (
                <span className="shots__toobig">{shot.name} — too large to show here</span>
              )}
              <figcaption>
                {shot.name} · {shot.tool}
              </figcaption>
            </figure>
          ))}
        </div>
      )}
    </section>
  );
}
