import { useEffect, useRef, useState } from 'react';
import type { SessionSummary, TranscriptEntry } from '@relay/shared';
import { SessionList } from './SessionList';
import { TranscriptView } from './TranscriptView';

/** How close to the bottom (px) still counts as "following" the transcript. */
const FOLLOW_THRESHOLD = 40;

export function App() {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [entries, setEntries] = useState<TranscriptEntry[]>([]);
  const [showSidechain, setShowSidechain] = useState(false);
  const panelRef = useRef<HTMLElement>(null);
  const followRef = useRef(true);
  const selected = sessions.find((s) => s.id === selectedId) ?? null;

  useEffect(() => {
    void window.relay.listSessions().then(setSessions);
    return window.relay.onSessionsChanged(setSessions);
  }, []);

  // Re-fetch only when the selected session itself changed; other sessions' activity must not
  // re-send a large transcript over IPC.
  const selectedVersion = selected ? `${selected.lastActivity}:${selected.messageCount}` : null;
  useEffect(() => {
    if (!selectedId) return;
    let cancelled = false;
    void window.relay.getTranscript(selectedId).then((t) => {
      if (!cancelled) setEntries(t);
    });
    return () => {
      cancelled = true;
    };
  }, [selectedId, selectedVersion]);

  // A newly opened session starts at its latest turn; updates keep following it unless the user scrolled up.
  useEffect(() => {
    followRef.current = true;
  }, [selectedId]);

  useEffect(() => {
    const panel = panelRef.current;
    if (panel && followRef.current) panel.scrollTop = panel.scrollHeight;
  }, [entries, showSidechain]);

  const onPanelScroll = () => {
    const panel = panelRef.current;
    if (!panel) return;
    followRef.current = panel.scrollHeight - panel.scrollTop - panel.clientHeight <= FOLLOW_THRESHOLD;
  };

  return (
    <div className="app">
      <SessionList sessions={sessions} selectedId={selectedId} onSelect={setSelectedId} />
      <main className="orchestrator" aria-label="Orchestrator">
        <p className="placeholder">Orchestrator chat arrives in milestone 3.</p>
      </main>
      <section className="session-panel" aria-label="Session panel" ref={panelRef} onScroll={onPanelScroll}>
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
