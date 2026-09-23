import { useState } from 'react';
import type { BulkRun } from '@relay/shared';

interface Props {
  run: BulkRun;
  onConfirm: (sessionIds: string[]) => void;
  onCancel: () => void;
}

const DETAIL_MAX = 160;
const clip = (t: string) => (t.length > DETAIL_MAX ? `${t.slice(0, DETAIL_MAX)}…` : t);
const plural = (n: number) => `${n} session${n === 1 ? '' : 's'}`;

/** A bulk run in the chat: a plan to confirm, then its per-row progress. */
export function BulkRunCard({ run, onConfirm, onCancel }: Props) {
  const [ticked, setTicked] = useState(() => new Set(run.rows.map((r) => r.sessionId)));
  const toggle = (id: string) =>
    setTicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  if (run.status === 'proposed') {
    return (
      <section className="bulk-card" aria-label="Bulk plan">
        <h3>Plan: {plural(run.rows.length)}</h3>
        <ul>
          {run.rows.map((r) => (
            <li key={r.sessionId}>
              <label>
                <input type="checkbox" aria-label={r.title} checked={ticked.has(r.sessionId)} onChange={() => toggle(r.sessionId)} />
                <strong>{r.title}</strong> {r.branch && <code>{r.branch}</code>}
              </label>
              <p className="bulk-card__prompt">{r.prompt}</p>
            </li>
          ))}
        </ul>
        <div className="bulk-card__actions">
          <button type="button" disabled={ticked.size === 0} onClick={() => onConfirm(run.rows.map((r) => r.sessionId).filter((id) => ticked.has(id)))}>
            Run on {plural(ticked.size)}
          </button>
          <button type="button" onClick={onCancel}>Cancel</button>
        </div>
      </section>
    );
  }

  const active = run.rows.filter((r) => r.status !== 'skipped');
  const done = active.filter((r) => r.status === 'done').length;
  const errors = active.filter((r) => r.status === 'error').length;
  return (
    <section className="bulk-card" aria-label="Bulk run">
      <h3>
        {run.status} · {done}/{active.length} done{errors ? `, ${errors} error${errors === 1 ? '' : 's'}` : ''}
      </h3>
      <ul>
        {run.rows.map((r) => (
          <li key={r.sessionId} className={`bulk-row bulk-row--${r.status}`}>
            <span className={`state state--${r.status}`}>{r.status}</span> <strong>{r.title}</strong>
            {r.detail && <p className="bulk-card__detail">{clip(r.detail)}</p>}
          </li>
        ))}
      </ul>
    </section>
  );
}
