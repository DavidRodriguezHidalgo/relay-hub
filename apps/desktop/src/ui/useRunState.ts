import { useEffect, useState } from 'react';
import type { BulkRun, ExternalSessions, GhStatus, LiveEntry, PendingApproval, PrWatch, RunState, RunnerEvent } from '@relay/shared';

export interface RunView {
  states: RunState['states'];
  approvals: PendingApproval[];
  liveEntries: Record<string, LiveEntry[]>;
  bulkRuns: BulkRun[];
  watches: PrWatch[];
  gh: GhStatus;
  external: ExternalSessions;
}

/** Mirrors the engine's run state in the renderer: initial snapshot, then events. */
export function useRunState(): RunView {
  const [view, setView] = useState<RunView>({ states: {}, approvals: [], liveEntries: {}, bulkRuns: [], watches: [], gh: { state: 'ok' }, external: {} });
  useEffect(() => {
    // events that arrive before the snapshot are replayed on top of it, so the snapshot never undoes them
    let early: RunnerEvent[] | null = [];
    void window.relay.runState().then((s) => {
      const replay = early ?? [];
      early = null;
      setView((v) =>
        replay.reduce(apply, { ...v, states: s.states, approvals: s.approvals, bulkRuns: s.bulkRuns, watches: s.watches, gh: s.gh, external: s.external ?? {} }),
      );
    });
    return window.relay.onRunnerEvent((event: RunnerEvent) => {
      early?.push(event);
      setView((v) => apply(v, event));
    });
  }, []);
  return view;
}

/** Live entries kept per session; the transcript file holds the full history. */
const LIVE_MAX = 500;

function apply(v: RunView, event: RunnerEvent): RunView {
      {
        switch (event.type) {
          case 'state':
            return { ...v, states: { ...v.states, [event.sessionId]: { state: event.state, error: event.error } } };
          case 'entry':
            return {
              ...v,
              liveEntries: {
                ...v.liveEntries,
                [event.sessionId]: [...(v.liveEntries[event.sessionId] ?? []), event.entry].slice(-LIVE_MAX),
              },
            };
          case 'approval':
            return { ...v, approvals: [...v.approvals, event.approval] };
          case 'approval-resolved':
            return { ...v, approvals: v.approvals.filter((a) => a.id !== event.approvalId) };
          case 'watch': {
            const others = v.watches.filter((w) => w.id !== event.watch.id);
            return { ...v, watches: [...others, event.watch], gh: event.gh };
          }
          case 'watch-removed':
            return { ...v, watches: v.watches.filter((w) => w.id !== event.watchId), gh: event.gh };
          case 'external':
            return { ...v, external: event.external };
          case 'pr-event':
            return v;
          case 'bulk': {
            const others = v.bulkRuns.filter((r) => r.id !== event.run.id);
            return { ...v, bulkRuns: [event.run, ...others].sort((a, b) => b.createdAt.localeCompare(a.createdAt)) };
          }
        }
      }
}
