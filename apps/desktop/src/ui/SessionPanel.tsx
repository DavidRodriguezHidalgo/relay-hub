import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import type {
  ApprovalDecision,
  DeliveryMode,
  Invocable,
  LiveEntry,
  ModelChoice,
  PendingApproval,
  PrWatch,
  QueuedMessage,
  SessionState,
  SessionSummary,
  TranscriptEntry,
  SessionStatus,
} from '@relay/shared';
import { ApprovalCard } from './ApprovalCard';
import type { Collision } from './collisions';
import { matchModels } from './matchModels';
import { DOT_LABEL, dotState } from './sessionDot';
import { applyCommand, commandItem, matchCommands, modelItem, SlashMenu, slashQuery, type MenuItem } from './SlashMenu';
import { imagePathsFrom, withPaths } from './fileDrop';
import { mergeEntries } from './mergeEntries';
import { TranscriptView } from './TranscriptView';
import { WorkingLine } from './WorkingLine';
import { WorkStanding } from './WorkStanding';

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
  /** Models this session can run on, with the one in use marked. */
  models: ModelChoice[];
  onSetModel: (id: string) => void;
  /** What has been sent to this session and what became of it. */
  queue: QueuedMessage[];
  /** What git and the forge say about this work; null until read. */
  standing: SessionStatus | null;
  /** Another live session working in the same place, when there is one. */
  collision: Collision | null;
  onNewWorktree: () => void;
  onDismissCollision: () => void;
  /** Why the last send or watch request failed; shown next to the send box. */
  notice: string | null;
  /** Commands, skills and plugins this session can be asked to run. */
  commands: Invocable[];
  /** The sidebar's indicator for this session; defaults to whatever its own state says. */
  dot?: string;
}

/** The first few names, then a count: a directory can hold more sessions than anyone reads. */
function namesOf(others: { title: string }[]): string {
  const shown = others.slice(0, 3).map((o) => o.title);
  const rest = others.length - shown.length;
  return rest > 0 ? `${shown.join(', ')} and ${rest} more` : shown.join(', ');
}

/**
 * What is still unanswered, and anything that was lost.
 *
 * Answered instructions disappear: the transcript above is where they live. One that was
 * never answered stays, because that is the case worth seeing.
 */
function InstructionQueue({ queue }: { queue: QueuedMessage[] }) {
  const pending = queue.filter((m) => m.state === 'pending');
  const dropped = queue.filter((m) => m.state === 'dropped');
  if (pending.length === 0 && dropped.length === 0) return null;
  return (
    <div className="queue">
      {pending.length > 0 && (
        <p className="queue__heading">
          {pending.length} instruction{pending.length === 1 ? '' : 's'} waiting to be answered
        </p>
      )}
      <ul className="queue__list">
        {[...pending, ...dropped].map((m) => (
          <li key={m.id} className={m.state === 'dropped' ? 'queue__item queue__item--dropped' : 'queue__item'}>
            <span className="queue__origin">{m.origin}</span> {m.text}
            {m.state === 'dropped' && <span className="queue__lost"> · never answered</span>}
          </li>
        ))}
      </ul>
    </div>
  );
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
  /** `/model` and what has been typed after it, which the app answers itself. */
  const modelQuery = draft.match(/^\/model(?:\s+([\s\S]*))?$/);
  const query = slashQuery(draft, caret);
  const matchingModels = modelQuery ? matchModels(p.models, (modelQuery[1] ?? '').trim()) : [];
  const matches: MenuItem[] = dismissed
    ? []
    : modelQuery
      ? matchingModels.map(modelItem)
      : query === null
        ? []
        : matchCommands(p.commands, query).map(commandItem);
  const pick = (item: MenuItem) => {
    if (modelQuery) {
      p.onSetModel(item.key);
      setDraft('');
      setHint(null);
      setActive(0);
      return;
    }
    const next = applyCommand(draft, caret, item.key);
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
    const model = text.match(/^\/model(?:\s+([\s\S]*))?$/);
    if (model) {
      const wanted = (model[1] ?? '').trim();
      const found = wanted ? matchModels(p.models, wanted)[0] : undefined;
      if (!wanted) {
        setHint('Pick a model from the list, or name one after /model.');
        return;
      }
      if (!found) {
        setHint(`There is no model matching "${wanted}".`);
        return;
      }
      p.onSetModel(found.id);
      setHint(null);
      setDraft('');
      return;
    }
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
      {p.collision && (
        <div role="alert" className="collision">
          <p className="collision__what">
            {p.collision.kind === 'directory' ? (
              <>
                Another session is working in the same directory, <code>{p.collision.cwd}</code>. Edits from both land
                on top of each other.
              </>
            ) : (
              <>
                Another session is on the same branch, <code>{p.collision.branch}</code>, from a different directory.
                Their work will meet at push time.
              </>
            )}
          </p>
          <p className="collision__who">{namesOf(p.collision.others)}</p>
          <div className="collision__actions">
            <button type="button" onClick={p.onNewWorktree}>
              Start one in its own worktree
            </button>
            <button type="button" onClick={p.onDismissCollision}>
              Dismiss
            </button>
          </div>
        </div>
      )}
      <WorkStanding status={p.standing} />
      <InstructionQueue queue={p.queue} />
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
