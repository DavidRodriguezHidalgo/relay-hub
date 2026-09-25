import { useState, type ReactNode } from 'react';
import type { ExternalSessions, RunState, SessionSummary } from '@relay/shared';
import { groupSessions } from './groupSessions';
import { recentSessions } from './recentSessions';
import { DOT_LABEL, dotState, isActive } from './sessionDot';

const COLLAPSED_KEY = 'relay.collapsedRepos';
const SHOW_ALL_KEY = 'relay.showAllSessions';

/** Past this, a session is close enough to full that the row should say so. */
const NEARLY_FULL = 85;

/** Per-viewer convenience: a failure to read or write storage just means nothing is remembered. */
function readStored<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

function writeStored(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // storage unavailable: the choice lasts for this window only
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
  /** Shown above everything, e.g. the todo list. */
  header?: ReactNode;
  /** Stops the turn of a session that is working, straight from its row. */
  onInterrupt?: (id: string) => void;
  /** Injectable so a test can say when "now" is. */
  now?: number;
}

export function SessionList({ sessions, selectedId, onSelect, states, external, onNewSession, panel, header, now, onInterrupt }: Props) {
  const [query, setQuery] = useState('');
  const [showStale, setShowStale] = useState(false);
  const [collapsed, setCollapsed] = useState(() => new Set(readStored<string[]>(COLLAPSED_KEY, [])));
  const [showAll, setShowAll] = useState(() => readStored<boolean>(SHOW_ALL_KEY, false));
  const { shown, hidden } = recentSessions(sessions, {
    now: now ?? Date.now(),
    states,
    external,
    selectedId,
    searching: query.trim() !== '',
    showAll,
  });
  const chooseShowAll = (on: boolean) => {
    setShowAll(on);
    writeStored(SHOW_ALL_KEY, on);
  };
  const groups = groupSessions(shown, { query, showStale });
  const toggle = (repo: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(repo)) next.delete(repo);
      else next.add(repo);
      writeStored(COLLAPSED_KEY, [...next]);
      return next;
    });
  return (
    <aside className="session-list">
      {header}
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
                    <li key={s.id} className="session-row__row">
                      <button
                        type="button"
                        className={s.id === selectedId ? 'session-row session-row--selected' : 'session-row'}
                        onClick={() => onSelect(s.id)}
                      >
                        <span className="session-row__title">
                          <span className={`dot dot--${dot}`} aria-label={DOT_LABEL[dot]} />
                          <span className="session-row__name">{s.title}</span>
                          {s.context && (
                            <span
                              className={
                                s.context.percent >= NEARLY_FULL
                                  ? 'session-row__context session-row__context--full'
                                  : 'session-row__context'
                              }
                              title={`Approximately ${s.context.percent}% of the context window used at the last request.`}
                            >
                              ~{s.context.percent}%
                            </span>
                          )}
                        </span>
                        <span className="session-row__meta">
                          {/* only what is not the resting state: an idle session says nothing here */}
                          {dot !== 'idle' && <span className="session-row__state">{DOT_LABEL[dot]}</span>}
                          <time dateTime={s.lastActivity}>{new Date(s.lastActivity).toLocaleDateString()}</time>
                        </span>
                      </button>
                      {isActive(dot) && onInterrupt && (
                        <button
                          type="button"
                          className="session-row__stop"
                          aria-label={`Stop ${s.title}`}
                          title={`Stop this turn (${s.title})`}
                          onClick={() => onInterrupt(s.id)}
                        >
                          Stop
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        );
      })}
      {hidden > 0 && (
        <button type="button" className="session-list__older" onClick={() => chooseShowAll(true)}>
          {hidden} older {hidden === 1 ? 'session' : 'sessions'} hidden · Show all
        </button>
      )}
      {showAll && (
        <button type="button" className="session-list__older" onClick={() => chooseShowAll(false)}>
          Showing all {sessions.length} · Show recent only
        </button>
      )}
    </aside>
  );
}
