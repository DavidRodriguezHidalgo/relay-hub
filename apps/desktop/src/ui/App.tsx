import { useEffect, useRef, useState } from 'react';
import { ORCHESTRATOR_KEY, type SessionSummary, type TranscriptEntry } from '@relay/shared';
import { ApprovalsDrawer } from './ApprovalsDrawer';
import { OrchestratorChat } from './OrchestratorChat';
import { SessionList } from './SessionList';
import { SessionPanel } from './SessionPanel';
import { useFollowBottom } from './useFollowBottom';
import { useRunState } from './useRunState';

export function App() {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [entries, setEntries] = useState<TranscriptEntry[]>([]);
  const [showSidechain, setShowSidechain] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [orchHistory, setOrchHistory] = useState<TranscriptEntry[]>([]);
  const panelRef = useRef<HTMLElement>(null);
  const run = useRunState();
  const selected = sessions.find((s) => s.id === selectedId) ?? null;
  const liveEntries = selected ? (run.liveEntries[selected.id] ?? []) : [];

  useEffect(() => {
    void window.relay.listSessions().then(setSessions);
    void window.relay.orchestratorHistory().then(setOrchHistory);
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

  useEffect(() => {
    setSendError(null);
  }, [selectedId]);

  // A newly opened session starts at its latest turn; updates keep following it unless the user scrolled up.
  const onPanelScroll = useFollowBottom(panelRef, [entries, liveEntries, showSidechain], selectedId);

  return (
    <div className="app">
      <SessionList sessions={sessions} selectedId={selectedId} onSelect={setSelectedId} states={run.states} />
      <main className="orchestrator" aria-label="Orchestrator">
        <OrchestratorChat
          history={orchHistory}
          liveEntries={run.liveEntries[ORCHESTRATOR_KEY] ?? []}
          state={run.states[ORCHESTRATOR_KEY]}
          onSend={(p) => void window.relay.orchestratorSend(p)}
          onInterrupt={() => void window.relay.orchestratorInterrupt()}
        />
        <ApprovalsDrawer
          approvals={run.approvals}
          sessions={sessions}
          onDecide={(id, d) => void window.relay.decide(id, d)}
          onOpenSession={setSelectedId}
        />
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
