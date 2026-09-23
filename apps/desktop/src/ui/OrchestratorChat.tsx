import { useRef, useState } from 'react';
import type { LiveEntry, TranscriptEntry } from '@relay/shared';
import { mergeEntries } from './mergeEntries';
import { TranscriptView, type ViewEntry } from './TranscriptView';
import { useFollowBottom } from './useFollowBottom';

interface Props {
  history: TranscriptEntry[];
  liveEntries: LiveEntry[];
  state: { state: string; error: string | null } | undefined;
  onSend: (prompt: string) => void;
  onInterrupt: () => void;
}

const RELAY_PREFIX = '[turn-end] ';

/** A message Relay itself fed the orchestrator (a finished turn), not something the user typed. */
function relayUpdate(e: ViewEntry): string | null {
  if (e.role !== 'user') return null;
  const first = e.blocks.find((b) => b.kind === 'text');
  const text = first && first.kind === 'text' ? first.text : '';
  if (e.origin?.startsWith('watch:') || text.startsWith(RELAY_PREFIX)) {
    return text.startsWith(RELAY_PREFIX) ? text.slice(RELAY_PREFIX.length) : text;
  }
  return null;
}

export function OrchestratorChat({ history, liveEntries, state, onSend, onInterrupt }: Props) {
  const [draft, setDraft] = useState('');
  const listRef = useRef<HTMLDivElement>(null);
  const entries = mergeEntries(history, liveEntries);
  const onScroll = useFollowBottom(listRef, [entries.length]);
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
        {entries.map((e) => {
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
        />
      </div>
    </>
  );
}
