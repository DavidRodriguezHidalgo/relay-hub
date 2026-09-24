import { useRef, useState } from 'react';
import { imagePathsFrom, withPaths } from './fileDrop';
import type { BulkRun, LiveEntry, PendingApproval, TranscriptEntry } from '@relay/shared';
import { BulkRunCard } from './BulkRunCard';
import { mergeEntries } from './mergeEntries';
import { TranscriptView, type ViewEntry } from './TranscriptView';
import { useFollowBottom } from './useFollowBottom';

interface Props {
  history: TranscriptEntry[];
  liveEntries: LiveEntry[];
  state: { state: string; error: string | null } | undefined;
  onSend: (prompt: string) => void;
  onInterrupt: () => void;
  bulkRuns: BulkRun[];
  onBulkConfirm: (runId: string, sessionIds: string[]) => void;
  onBulkCancel: (runId: string) => void;
  approvals: PendingApproval[];
}

type Item = { kind: 'entry'; at: string; entry: ViewEntry } | { kind: 'bulk'; at: string; run: BulkRun };

/** Messages Relay itself feeds the orchestrator; shown as compact update lines. */
const RELAY_PREFIXES = ['[turn-end] ', '[bulk-end] '];

/** A message Relay itself fed the orchestrator (a finished turn), not something the user typed. */
function relayUpdate(e: ViewEntry): string | null {
  if (e.role !== 'user') return null;
  const first = e.blocks.find((b) => b.kind === 'text');
  // tool results in a relay-started turn carry its origin too, but have no text
  if (!first || first.kind !== 'text') return null;
  const text = first.text;
  const prefix = RELAY_PREFIXES.find((p) => text.startsWith(p));
  if (e.origin?.startsWith('watch:') || prefix) return prefix ? text.slice(prefix.length) : text;
  return null;
}

export function OrchestratorChat({
  history,
  liveEntries,
  state,
  onSend,
  onInterrupt,
  bulkRuns,
  onBulkConfirm,
  onBulkCancel,
  approvals,
}: Props) {
  const [draft, setDraft] = useState('');
  const listRef = useRef<HTMLDivElement>(null);
  const entries = mergeEntries(history, liveEntries);
  // one timeline: plan cards sit among the messages by time (stable sort keeps equal-time order)
  const timeline: Item[] = [
    ...entries.map((entry): Item => ({ kind: 'entry', at: entry.timestamp, entry })),
    ...bulkRuns.map((run): Item => ({ kind: 'bulk', at: run.createdAt, run })),
  ].sort((a, b) => a.at.localeCompare(b.at) || (a.kind === 'entry' ? -1 : 1));
  const onScroll = useFollowBottom(listRef, [timeline.length, bulkRuns]);
  const running = state?.state === 'running' || state?.state === 'waiting-approval';

  const submit = () => {
    if (!draft.trim()) return;
    onSend(draft);
    setDraft('');
  };

  return (
    <>
      <header className="chat__header">
        <strong>Relay</strong>
        <span className={`state state--${state?.state ?? 'idle'}`}>{state?.state ?? 'idle'}</span>
        {running && (
          <button type="button" onClick={onInterrupt}>
            Interrupt
          </button>
        )}
      </header>
      {state?.error && <p className="error">{state.error}</p>}
      <div className="chat" ref={listRef} onScroll={onScroll}>
        {timeline.map((item) => {
          if (item.kind === 'bulk') {
            const { run } = item;
            return (
              <BulkRunCard
                key={run.id}
                run={run}
                onConfirm={(ids) => onBulkConfirm(run.id, ids)}
                onCancel={() => onBulkCancel(run.id)}
                approvals={approvals}
              />
            );
          }
          const e = item.entry;
          const update = relayUpdate(e);
          return update !== null ? (
            <div key={e.uuid} role="status" aria-label="Relay update" className="relay-update">
              {update}
            </div>
          ) : (
            <TranscriptView key={e.uuid} entries={[e]} hideSidechain />
          );
        })}
      </div>
      <div className="chat-input">
        <textarea
          placeholder="Ask Relay…"
          rows={3}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          onDragOver={(e) => {
            if (e.dataTransfer.types.includes('Files')) e.preventDefault();
          }}
          onDrop={(e) => {
            const paths = imagePathsFrom(e.dataTransfer);
            if (paths.length === 0) return;
            e.preventDefault();
            setDraft((d) => withPaths(d, paths));
          }}
        />
      </div>
    </>
  );
}
