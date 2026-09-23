import { useEffect, useState } from 'react';
import type { LiveEntry, PendingApproval, RunState, RunnerEvent } from '@relay/shared';

export interface RunView {
  states: RunState['states'];
  approvals: PendingApproval[];
  liveEntries: Record<string, LiveEntry[]>;
}

/** Mirrors the engine's run state in the renderer: initial snapshot, then events. */
export function useRunState(): RunView {
  const [view, setView] = useState<RunView>({ states: {}, approvals: [], liveEntries: {} });
  useEffect(() => {
    void window.relay.runState().then((s) => setView((v) => ({ ...v, states: s.states, approvals: s.approvals })));
    return window.relay.onRunnerEvent((event: RunnerEvent) => {
      setView((v) => {
        switch (event.type) {
          case 'state':
            return { ...v, states: { ...v.states, [event.sessionId]: { state: event.state, error: event.error } } };
          case 'entry':
            return {
              ...v,
              liveEntries: {
                ...v.liveEntries,
                [event.sessionId]: [...(v.liveEntries[event.sessionId] ?? []), event.entry],
              },
            };
          case 'approval':
            return { ...v, approvals: [...v.approvals, event.approval] };
          case 'approval-resolved':
            return { ...v, approvals: v.approvals.filter((a) => a.id !== event.approvalId) };
        }
      });
    });
  }, []);
  return view;
}
