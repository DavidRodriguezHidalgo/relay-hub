import { useState } from 'react';
import type { SessionSummary } from '@relay/shared';
import { groupSessions } from './groupSessions';

interface Props {
  sessions: SessionSummary[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}

export function SessionList({ sessions, selectedId, onSelect }: Props) {
  const [query, setQuery] = useState('');
  const [showStale, setShowStale] = useState(false);
  const groups = groupSessions(sessions, { query, showStale });
  return (
    <aside className="session-list">
      <div className="session-list__controls">
        <input
          type="search"
          placeholder="Search sessions"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <label>
          <input
            type="checkbox"
            aria-label="Show stale"
            checked={showStale}
            onChange={(e) => setShowStale(e.target.checked)}
          />
          Stale
        </label>
      </div>
      {groups.map((g) => (
        <section key={g.repo}>
          <h2>{g.repo}</h2>
          <ul>
            {g.sessions.map((s) => (
              <li key={s.id}>
                <button
                  type="button"
                  className={s.id === selectedId ? 'session-row session-row--selected' : 'session-row'}
                  onClick={() => onSelect(s.id)}
                >
                  <span className="session-row__title">{s.title}</span>
                  <span className="session-row__meta">
                    {s.branch && <code>{s.branch}</code>}
                    {s.prNumber !== null && <span className="badge">#{s.prNumber}</span>}
                    <time dateTime={s.lastActivity}>{new Date(s.lastActivity).toLocaleDateString()}</time>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </aside>
  );
}
