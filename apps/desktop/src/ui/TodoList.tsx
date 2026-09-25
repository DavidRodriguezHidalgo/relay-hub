import { useState } from 'react';
import type { ExternalSessions, RunState, SessionSummary, Todo, TodoDraft, TodoPatch } from '@relay/shared';
import { DOT_LABEL, dotState } from './sessionDot';

interface Project {
  name: string;
  root: string;
  sessions: number;
}

interface Props {
  todos: Todo[];
  sessions: SessionSummary[];
  projects: Project[];
  states?: RunState['states'];
  external?: ExternalSessions;
  onCreate: (draft: TodoDraft) => Promise<unknown>;
  onUpdate: (id: string, patch: TodoPatch) => Promise<unknown>;
  onDelete: (id: string) => Promise<unknown>;
  onLaunch: (id: string) => Promise<unknown>;
  /** Hands the item to a session that is already open. */
  onAttach: (id: string, sessionId: string) => Promise<unknown>;
  onDetach: (id: string) => Promise<unknown>;
  onOpenSession: (sessionId: string) => void;
}

/**
 * What sending this item to that session will actually do.
 *
 * "Sent" must never quietly mean "will start in a while", and a session another Claude process
 * is holding cannot take it at all.
 */
export function deliveryNote(dot: string): { text: string; can: boolean } {
  if (dot === 'elsewhere' || dot === 'open') {
    return { text: 'Open in another process — take it over first.', can: false };
  }
  if (dot === 'running') return { text: 'Working now — this will be queued behind its current turn.', can: true };
  if (dot === 'waiting-approval') return { text: 'Waiting on you — this will be queued behind that.', can: true };
  return { text: 'Idle — it starts on this straight away.', can: true };
}

/**
 * The work you mean to do, and what became of it.
 *
 * A row shows the session it launched rather than a slot: the branch it is working on and what
 * that session is doing right now, both read from the session itself so the two cannot disagree.
 */
export function TodoList({ todos, sessions, projects, states, external, onCreate, onUpdate, onDelete, onLaunch, onAttach, onDetach, onOpenSession }: Props) {
  const [title, setTitle] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** The todo whose "send to a session" picker is open, and what has been picked for it. */
  const [sendingId, setSendingId] = useState<string | null>(null);
  const [pickedId, setPickedId] = useState('');

  const report = async (work: Promise<unknown>) => {
    setError(null);
    try {
      await work;
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const add = async () => {
    const text = title.trim();
    if (!text) return;
    setTitle('');
    await report(onCreate({ title: text }));
  };

  const launch = async (id: string) => {
    setBusyId(id);
    await report(onLaunch(id));
    setBusyId(null);
  };

  return (
    <section className="todos" aria-label="Work">
      <h2 className="todos__heading">Work to do</h2>
      <input
        className="todos__add"
        aria-label="What needs doing"
        placeholder="Add a piece of work…"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            void add();
          }
        }}
      />
      {todos.length === 0 && (
        <p className="todos__empty">Anything you add here can be handed to a Claude session, which then does the work.</p>
      )}
      {error && (
        <p role="alert" className="error todos__error">
          {error}
        </p>
      )}
      {todos.length > 0 && (
        <ul className="todos__list">
          {todos.map((t) => {
            const session = t.sessionId ? (sessions.find((s) => s.id === t.sessionId) ?? null) : null;
            const dot = session ? dotState(session.id, states, external) : null;
            const expanded = openId === t.id;
            return (
              <li key={t.id} className={t.done ? 'todo todo--done' : 'todo'}>
                <div className="todo__head">
                  <input
                    type="checkbox"
                    aria-label={t.title}
                    checked={t.done}
                    onChange={(e) => void report(onUpdate(t.id, { done: e.target.checked }))}
                  />
                  <button
                    type="button"
                    className="todo__title"
                    aria-expanded={expanded}
                    onClick={() => setOpenId(expanded ? null : t.id)}
                  >
                    <span className="todo__caret" aria-hidden="true">
                      {expanded ? '▾' : '▸'}
                    </span>
                    {t.title}
                  </button>
                </div>
                <div className="todo__meta">
                  {session && dot ? (
                    <button type="button" className="todo__session" onClick={() => onOpenSession(session.id)}>
                      <span className={`dot dot--${dot}`} aria-label={DOT_LABEL[dot]} />
                      <code>{session.branch ?? session.repo}</code>
                      <span className="todo__state">{DOT_LABEL[dot]}</span>
                    </button>
                  ) : t.sessionId ? (
                    <span className="todo__gone">Its session is gone.</span>
                  ) : (
                    <>
                      {t.project ? (
                        <button
                          type="button"
                          className="todo__launch"
                          disabled={busyId === t.id}
                          title={`Start a Claude session in ${t.project} and hand it this work`}
                          onClick={() => void launch(t.id)}
                        >
                          {busyId === t.id ? 'Starting a session…' : 'Start a session'}
                        </button>
                      ) : (
                        // a dead disabled button explains nothing; this says what is missing and opens it
                        <button type="button" className="todo__needs" onClick={() => setOpenId(t.id)}>
                          Choose a project first
                        </button>
                      )}
                      <button
                        type="button"
                        className="todo__send"
                        onClick={() => {
                          setSendingId(sendingId === t.id ? null : t.id);
                          setPickedId('');
                        }}
                      >
                        Send to a session…
                      </button>
                    </>
                  )}
                </div>
                {sendingId === t.id && !t.sessionId && (
                  <div className="todo__picker">
                    {sessions.length === 0 ? (
                      <p className="todo__note">No sessions open to send it to.</p>
                    ) : (
                      <>
                        <label>
                          Send it to
                          <select
                            aria-label="Session to send it to"
                            value={pickedId}
                            onChange={(e) => setPickedId(e.target.value)}
                          >
                            <option value="">Choose a session…</option>
                            {sessions.map((s) => (
                              <option key={s.id} value={s.id}>
                                {s.title} — {s.branch ?? s.repo} · {DOT_LABEL[dotState(s.id, states, external)]}
                              </option>
                            ))}
                          </select>
                        </label>
                        {pickedId && (
                          <p className="todo__note">{deliveryNote(dotState(pickedId, states, external)).text}</p>
                        )}
                        <button
                          type="button"
                          className="todo__launch"
                          disabled={
                            !pickedId || busyId === t.id || !deliveryNote(dotState(pickedId, states, external)).can
                          }
                          onClick={() => {
                            setBusyId(t.id);
                            void report(onAttach(t.id, pickedId)).then(() => {
                              setBusyId(null);
                              setSendingId(null);
                            });
                          }}
                        >
                          Send
                        </button>
                      </>
                    )}
                  </div>
                )}
                {expanded && (
                  <div className="todo__detail">
                    <label>
                      Context
                      <textarea
                        aria-label="Context"
                        rows={3}
                        defaultValue={t.notes}
                        placeholder="What it is for, what done looks like, links"
                        onBlur={(e) => {
                          if (e.target.value !== t.notes) void report(onUpdate(t.id, { notes: e.target.value }));
                        }}
                      />
                    </label>
                    {!t.sessionId && (
                      <>
                        <label>
                          Project
                          <select
                            aria-label="Project"
                            value={t.project ?? ''}
                            onChange={(e) => void report(onUpdate(t.id, { project: e.target.value || null }))}
                          >
                            <option value="">Choose a repo…</option>
                            {projects.map((p) => (
                              <option key={p.root} value={p.root}>
                                {p.name}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label>
                          Branch
                          <input
                            aria-label="Branch"
                            placeholder="its own worktree, or blank to work in place"
                            defaultValue={t.branch ?? ''}
                            onBlur={(e) => {
                              const next = e.target.value.trim() || null;
                              if (next !== t.branch) void report(onUpdate(t.id, { branch: next }));
                            }}
                          />
                        </label>
                      </>
                    )}
                    {t.sessionId && (
                      // one item, one session: to point it elsewhere, let go of this one first
                      <button type="button" className="todo__needs" onClick={() => void report(onDetach(t.id))}>
                        Detach from its session
                      </button>
                    )}
                    <button type="button" className="todo__remove" onClick={() => void report(onDelete(t.id))}>
                      Remove
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
