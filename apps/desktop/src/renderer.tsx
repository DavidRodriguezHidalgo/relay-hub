import { createRoot } from 'react-dom/client';
import { useEffect, useState } from 'react';
import type { SessionSummary } from '@relay/shared';

function App() {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  useEffect(() => {
    void window.relay.listSessions().then(setSessions);
    return window.relay.onSessionsChanged(setSessions);
  }, []);
  return <pre data-testid="session-count">{sessions.length} sessions</pre>;
}

createRoot(document.getElementById('root')!).render(<App />);
