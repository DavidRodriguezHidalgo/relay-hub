import { useState, type ReactNode } from 'react';
import type { ExternalSessions, RunState, SessionSummary } from '@relay/shared';
import { groupSessions } from './groupSessions';
import { DOT_LABEL, dotState, isActive } from './sessionDot';

const COLLAPSED_KEY = 'relay.collapsedRepos';

/** Per-viewer convenience: a failure to read or write storage just means nothing is remembered. */
function loadCollapsed(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? '[]') as string[]);
  } catch {
    return new Set();
  }
}

function saveCollapsed(repos: Set<string>): void {
  try {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...repos]));
  } catch {
    // storage unavailable: collapse state lasts for this window only
  }
}

interface Props {
  sessions: SessionSummary[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  states?: RunState['states'];
  /** Sessions open in another Claude process, busy or idle. */
  external?: ExternalSessions;
  onNewSession?: () => void;
  /** Shown under the controls, e.g. the new-session form. */
  panel?: ReactNode;
}

export function SessionList({ sessions, selectedId, onSelect, states, external, onNewSession, panel }: Props) {
  const [query, setQuery] = useState('');
  const [showStale, setShowStale] = useState(false);
  const [collapsed, setCollapsed] = useState(loadCollapsed);
  const groups = groupSessions(sessions, { query, showStale });
  const toggle = (repo: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(repo)) next.delete(repo);
      else next.add(repo);
      saveCollapsed(next);
      return next;
    });
  return (
    <aside className="session-list">
      {onNewSession && (
        <button type="button" className="btn-primary session-list__new" onClick={onNewSession}>
          New session
        </button>
      )}
      {panel}
      <div className="session-list__controls">
        <input type="search" placeholder="Search sessions" value={query} onChange={(e) => setQuery(e.target.value)} />
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
      {groups.map((g) => {
        const isCollapsed = collapsed.has(g.repo);
        // collapsing a group must not hide that something inside it is working
        const busy = g.sessions.map((x) => dotState(x.id, states, external)).find(isActive);
        return (
          <section key={g.repo}>
            <h2>
              <button
                type="button"
                className="session-list__group"
                aria-expanded={!isCollapsed}
                onClick={() => toggle(g.repo)}
              >
                <span className="session-list__caret" aria-hidden="true">
                  {isCollapsed ? '▶' : '▼'}
                </span>{' '}
                {g.repo}
                {isCollapsed && busy && <span className={`dot dot--${busy}`} aria-label={DOT_LABEL[busy]} />}
                {isCollapsed && <span className="session-list__count">{g.sessions.length}</span>}
              </button>
            </h2>
            {!isCollapsed && (
              <ul>
                {g.sessions.map((s) => {
                  const dot = dotState(s.id, states, external);
                  return (
                    <li key={s.id}>
                      <button
                        type="button"
                        className={s.id === selectedId ? 'session-row session-row--selected' : 'session-row'}
                        onClick={() => onSelect(s.id)}
                      >
                        <span className="session-row__title">
                          <span className={`dot dot--${dot}`} aria-label={DOT_LABEL[dot]} />
                          {s.title}
                        </span>
                        <span className="session-row__meta">
                          {s.branch && <code>{s.branch}</code>}
                          {s.prNumber !== null && <span className="badge">#{s.prNumber}</span>}
                          <time dateTime={s.lastActivity}>{new Date(s.lastActivity).toLocaleDateString()}</time>
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        );
      })}
    </aside>
  );
}
