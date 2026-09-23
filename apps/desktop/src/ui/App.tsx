import { useEffect, useRef, useState } from 'react';
import type { SessionSummary, TranscriptEntry } from '@relay/shared';
import { SessionList } from './SessionList';
import { SessionPanel } from './SessionPanel';
import { useRunState } from './useRunState';

/** How close to the bottom (px) still counts as "following" the transcript. */
const FOLLOW_THRESHOLD = 40;

export function App() {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [entries, setEntries] = useState<TranscriptEntry[]>([]);
  const [showSidechain, setShowSidechain] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const panelRef = useRef<HTMLElement>(null);
  const followRef = useRef(true);
  const run = useRunState();
  const selected = sessions.find((s) => s.id === selectedId) ?? null;
  const liveEntries = selected ? (run.liveEntries[selected.id] ?? []) : [];

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
    setSendError(null);
  }, [selectedId]);

  useEffect(() => {
    const panel = panelRef.current;
    if (panel && followRef.current) panel.scrollTop = panel.scrollHeight;
  }, [entries, liveEntries, showSidechain]);

  const onPanelScroll = () => {
    const panel = panelRef.current;
    if (!panel) return;
    followRef.current = panel.scrollHeight - panel.scrollTop - panel.clientHeight <= FOLLOW_THRESHOLD;
  };

  return (
    <div className="app">
      <SessionList sessions={sessions} selectedId={selectedId} onSelect={setSelectedId} states={run.states} />
      <main className="orchestrator" aria-label="Orchestrator">
        <p className="placeholder">Orchestrator chat arrives in milestone 3.</p>
      </main>
      <section className="session-panel" aria-label="Session panel" ref={panelRef} onScroll={onPanelScroll}>
        {sendError && <p className="error">{sendError}</p>}
        {selected ? (
          <SessionPanel
            session={selected}
            entries={entries}
            liveEntries={liveEntries}
            state={run.states[selected.id]}
            approvals={run.approvals.filter((a) => a.sessionId === selected.id)}
            showSidechain={showSidechain}
            onToggleSidechain={setShowSidechain}
            onDecide={(id, d) => void window.relay.decide(id, d)}
            onSend={(prompt, mode) =>
              void window.relay
                .send({ sessionId: selected.id, prompt, mode, origin: 'user' })
                .then(() => setSendError(null))
                .catch((e: unknown) => setSendError(e instanceof Error ? e.message : String(e)))
            }
            onInterrupt={() => void window.relay.interrupt(selected.id)}
            devTools={import.meta.env.DEV}
          />
        ) : (
          <p className="placeholder">Select a session.</p>
        )}
      </section>
    </div>
  );
}
