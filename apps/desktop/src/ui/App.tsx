import { useEffect, useState } from 'react';
import type { SessionSummary } from '@relay/shared';
import { SessionList } from './SessionList';

export function App() {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  useEffect(() => {
    void window.relay.listSessions().then(setSessions);
    return window.relay.onSessionsChanged(setSessions);
  }, []);
  return (
    <div className="app">
      <SessionList sessions={sessions} selectedId={selectedId} onSelect={setSelectedId} />
      <main className="orchestrator" aria-label="Orchestrator">
        <p className="placeholder">Orchestrator chat arrives in milestone 3.</p>
      </main>
      <section className="session-panel" aria-label="Session panel" data-session-id={selectedId ?? ''} />
    </div>
  );
}
