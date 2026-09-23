import { useState } from 'react';
import type {
  ApprovalDecision,
  DeliveryMode,
  LiveEntry,
  PendingApproval,
  PrWatch,
  SessionSummary,
  TranscriptEntry,
} from '@relay/shared';
import { ApprovalCard } from './ApprovalCard';
import { mergeEntries } from './mergeEntries';
import { TranscriptView } from './TranscriptView';

interface Props {
  session: SessionSummary;
  entries: TranscriptEntry[];
  liveEntries: LiveEntry[];
  state: { state: string; error: string | null } | undefined;
  approvals: PendingApproval[];
  showSidechain: boolean;
  onToggleSidechain: (v: boolean) => void;
  onDecide: (id: string, decision: ApprovalDecision) => void;
  onSend: (prompt: string, mode: DeliveryMode) => void;
  onInterrupt: () => void;
  devTools: boolean;
  watch: PrWatch | null;
  onWatch: () => void;
  onUnwatch: (watchId: string) => void;
}

export function SessionPanel(p: Props) {
  const [draft, setDraft] = useState('');
  const [mode, setMode] = useState<DeliveryMode>('steer');
  const state = p.state?.state ?? 'idle';
  const submit = () => {
    if (!draft.trim()) return;
    p.onSend(draft, mode);
    setDraft('');
  };
  return (
    <>
      <header className="session-panel__header">
        <h1>{p.session.title}</h1>
        <p>
          <span className={`state state--${state}`}>{state}</span> <code>{p.session.cwd}</code>{' '}
          {p.session.branch && <code>{p.session.branch}</code>}{' '}
          {p.session.prUrl && (
            <a href={p.session.prUrl} target="_blank" rel="noreferrer">
              PR #{p.session.prNumber}
            </a>
          )}{' '}
          {p.watch ? (
            <>
              <span className="watch">
                Watching PR #{p.watch.prNumber}
                {p.watch.lastPolledAt && ` · checked ${new Date(p.watch.lastPolledAt).toLocaleTimeString()}`}
              </span>{' '}
              <button type="button" onClick={() => p.onUnwatch(p.watch!.id)}>
                Stop watching
              </button>
              {p.watch.lastError && <span className="error"> {p.watch.lastError}</span>}
            </>
          ) : (
            <button type="button" className="btn-primary" onClick={p.onWatch}>
              Watch PR
            </button>
          )}
        </p>
        {p.state?.error && <p className="error">{p.state.error}</p>}
        <label>
          <input type="checkbox" checked={p.showSidechain} onChange={(e) => p.onToggleSidechain(e.target.checked)} />{' '}
          Show subagent turns
        </label>
      </header>
      {p.approvals.map((a) => (
        <ApprovalCard key={a.id} approval={a} onDecide={p.onDecide} />
      ))}
      <TranscriptView entries={mergeEntries(p.entries, p.liveEntries)} hideSidechain={!p.showSidechain} />
      {p.devTools && (
        <form
          className="dev-send"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <textarea
            placeholder="Send to this session (dev)"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={2}
          />
          <div className="dev-send__row">
            <select aria-label="Delivery" value={mode} onChange={(e) => setMode(e.target.value as DeliveryMode)}>
              <option value="steer">steer</option>
              <option value="queue">queue</option>
              <option value="interrupt">interrupt</option>
            </select>
            <button type="submit" className="btn-primary">Send</button>
            <button type="button" onClick={p.onInterrupt}>
              Interrupt
            </button>
          </div>
        </form>
      )}
    </>
  );
}
