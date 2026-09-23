import { useEffect, useState } from 'react';
import type { SessionSummary, TranscriptEntry } from '@relay/shared';
import { SessionList } from './SessionList';
import { TranscriptView } from './TranscriptView';

export function App() {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [entries, setEntries] = useState<TranscriptEntry[]>([]);
  const [showSidechain, setShowSidechain] = useState(false);
  const selected = sessions.find((s) => s.id === selectedId) ?? null;

  useEffect(() => {
    void window.relay.listSessions().then(setSessions);
    return window.relay.onSessionsChanged(setSessions);
  }, []);

  // Re-fetch when the watcher reports a change so a live session's panel stays current.
  useEffect(() => {
    if (!selectedId) return;
    let cancelled = false;
    void window.relay.getTranscript(selectedId).then((t) => {
      if (!cancelled) setEntries(t);
    });
    return () => {
      cancelled = true;
    };
  }, [selectedId, sessions]);

  return (
    <div className="app">
      <SessionList sessions={sessions} selectedId={selectedId} onSelect={setSelectedId} />
      <main className="orchestrator" aria-label="Orchestrator">
        <p className="placeholder">Orchestrator chat arrives in milestone 3.</p>
      </main>
      <section className="session-panel" aria-label="Session panel">
        {selected ? (
          <>
            <header className="session-panel__header">
              <h1>{selected.title}</h1>
              <p>
                <code>{selected.cwd}</code> {selected.branch && <code>{selected.branch}</code>}{' '}
                {selected.prUrl && (
                  <a href={selected.prUrl} target="_blank" rel="noreferrer">
                    PR #{selected.prNumber}
                  </a>
                )}
              </p>
              <label>
                <input
                  type="checkbox"
                  checked={showSidechain}
                  onChange={(e) => setShowSidechain(e.target.checked)}
                />{' '}
                Show subagent turns
              </label>
            </header>
            <TranscriptView entries={entries} hideSidechain={!showSidechain} />
          </>
        ) : (
          <p className="placeholder">Select a session.</p>
        )}
      </section>
    </div>
  );
}
