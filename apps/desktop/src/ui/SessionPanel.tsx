import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import type {
  ApprovalDecision,
  DeliveryMode,
  Invocable,
  LiveEntry,
  PendingApproval,
  PrWatch,
  SessionState,
  SessionSummary,
  TranscriptEntry,
} from '@relay/shared';
import { ApprovalCard } from './ApprovalCard';
import { DOT_LABEL, dotState } from './sessionDot';
import { applyCommand, matchCommands, SlashMenu, slashQuery } from './SlashMenu';
import { imagePathsFrom, withPaths } from './fileDrop';
import { mergeEntries } from './mergeEntries';
import { TranscriptView } from './TranscriptView';
import { WorkingLine } from './WorkingLine';

interface Props {
  session: SessionSummary;
  entries: TranscriptEntry[];
  liveEntries: LiveEntry[];
  state: { state: SessionState; error: string | null } | undefined;
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
  /** Set when another Claude process has this session open, so it can be taken over. */
  heldElsewhere: 'busy' | 'idle' | null;
  onTakeOver: () => void;
  /** A /btw question: answered beside the work, never sent into it. */
  onAside: (question: string) => void;
  /** Why the last send or watch request failed; shown next to the send box. */
  notice: string | null;
  /** Commands, skills and plugins this session can be asked to run. */
  commands: Invocable[];
  /** The sidebar's indicator for this session; defaults to whatever its own state says. */
  dot?: string;
}

export function SessionPanel(p: Props) {
  const [draft, setDraft] = useState('');
  const [mode, setMode] = useState<DeliveryMode>('steer');
  /** Taking over stops someone else's Claude, so it takes two presses. */
  const [confirmingTakeOver, setConfirmingTakeOver] = useState(false);
  /** Why the last thing typed was not sent, e.g. a /btw with no question. */
  const [hint, setHint] = useState<string | null>(null);
  const [caret, setCaret] = useState(0);
  const [active, setActive] = useState(0);
  /** Escape shuts the menu for this command; it opens again only once a new one is started. */
  const [dismissed, setDismissed] = useState(false);
  const boxRef = useRef<HTMLTextAreaElement>(null);
  /** Where the caret must land once a picked command is on screen. */
  const [caretAfterPick, setCaretAfterPick] = useState<number | null>(null);

  // synchronously, before the user can type: a frame's delay lets keystrokes land at the old spot
  useLayoutEffect(() => {
    const box = boxRef.current;
    if (!box || caretAfterPick === null) return;
    box.focus();
    box.setSelectionRange(caretAfterPick, caretAfterPick);
    setCaretAfterPick(null);
  }, [caretAfterPick, draft]);
  const query = slashQuery(draft, caret);
  const matches = query === null || dismissed ? [] : matchCommands(p.commands, query);
  const pick = (command: Invocable) => {
    const next = applyCommand(draft, caret, command.name);
    setDraft(next.value);
    setCaret(next.caret);
    setActive(0);
    setCaretAfterPick(next.caret);
  };
  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (matches.length === 0) {
      // Enter sends; Shift+Enter is how you get a new line. Mid-composition Enter belongs to the IME.
      if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
        e.preventDefault();
        submit();
      }
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const step = e.key === 'ArrowDown' ? 1 : -1;
      setActive((i) => Math.min(matches.length - 1, Math.max(0, i + step)));
      return;
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      pick(matches[active] ?? matches[0]!);
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      setDismissed(true);
    }
  };
  const merged = useMemo(() => mergeEntries(p.entries, p.liveEntries), [p.entries, p.liveEntries]);
  const state = p.state?.state ?? 'idle';
  const dot = p.dot ?? dotState(p.session.id, p.state ? { [p.session.id]: p.state } : undefined);
  const submit = () => {
    const text = draft.trim();
    if (!text) return;
    const aside = text.match(/^\/btw(?:\s+([\s\S]*))?$/);
    if (aside) {
      const question = (aside[1] ?? '').trim();
      if (!question) {
        setHint('Put the side question after /btw, e.g. /btw why did you pick sqlite?');
        return;
      }
      p.onAside(question);
    } else {
      p.onSend(draft, mode);
    }
    setHint(null);
    setDraft('');
  };
  return (
    <>
      <header className="session-panel__header">
        <h1>{p.session.title}</h1>
        <p>
          <span className={`dot dot--${dot}`} aria-label={DOT_LABEL[dot]} />
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
              {p.watch.wakeError && <span className="error"> Could not wake the session: {p.watch.wakeError}</span>}
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
      <TranscriptView entries={merged} hideSidechain={!p.showSidechain} />
      {!p.devTools && p.notice && (
        <p role="alert" className="error">
          {p.notice}
        </p>
      )}
      {state === 'running' && <WorkingLine />}
      {p.heldElsewhere && (
        <div className="held-elsewhere">
          <span>
            Another Claude has this session open{p.heldElsewhere === 'busy' ? ' and is working in it' : ''}. Relay cannot
            send to it until that one stops.
          </span>
          <button
            type="button"
            className={confirmingTakeOver ? 'btn-takeover btn-takeover--confirm' : 'btn-takeover'}
            onClick={() => {
              if (!confirmingTakeOver) {
                setConfirmingTakeOver(true);
                return;
              }
              setConfirmingTakeOver(false);
              p.onTakeOver();
            }}
          >
            {confirmingTakeOver ? 'Confirm: stop the other Claude' : 'Take over'}
          </button>
        </div>
      )}
      {p.devTools && (
        <form
          className="dev-send"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          {p.notice && (
            <p role="alert" className="error">
              {p.notice}
            </p>
          )}
          <SlashMenu items={matches} activeIndex={active} onPick={pick} onHover={setActive} />
          {hint && (
            <p role="alert" className="error">
              {hint}
            </p>
          )}
          <textarea
            ref={boxRef}
            placeholder="Send to this session (dev)"
            value={draft}
            onChange={(e) => {
              const next = e.target.value;
              const at = e.target.selectionStart ?? next.length;
              setDraft(next);
              setCaret(at);
              setActive(0);
              if (slashQuery(next, at) === null) setDismissed(false);
            }}
            onKeyDown={onKeyDown}
            onSelect={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
          onDragOver={(e) => {
            if (e.dataTransfer.types.includes('Files')) e.preventDefault();
          }}
          onDrop={(e) => {
            const paths = imagePathsFrom(e.dataTransfer);
            if (paths.length === 0) return;
            e.preventDefault();
            setDraft((d) => withPaths(d, paths));
          }}
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
