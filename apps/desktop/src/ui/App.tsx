import { useEffect, useRef, useState } from 'react';
import { IPC, ORCHESTRATOR_KEY, type Invocable, type SessionSummary, type TranscriptEntry, type UpdateCheck, type ModelChoice } from '@relay/shared';
import { ApprovalsDrawer } from './ApprovalsDrawer';
import { ColumnResizer } from './ColumnResizer';
import { Settings } from './Settings';
import { applyTheme, loadTheme, saveTheme, systemTheme, type Theme } from './theme';
import { clampWidth, loadWidths, saveWidths, type ColumnWidths } from './columnWidths';
import { NewSessionForm } from './NewSessionForm';
import { OrchestratorChat } from './OrchestratorChat';
import { SessionList } from './SessionList';
import { SessionPanel } from './SessionPanel';
import { dotState } from './sessionDot';
import { useFollowBottom } from './useFollowBottom';
import { useRunState } from './useRunState';

/** Stable empty list: a new array each render would defeat the transcript's memoisation. */
const NO_ENTRIES: TranscriptEntry[] = [];

export function App() {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  /** Transcript plus the session it belongs to, so one session's history can never show under another. */
  const [loaded, setLoaded] = useState<{ id: string | null; entries: TranscriptEntry[] }>({ id: null, entries: [] });
  const [showSidechain, setShowSidechain] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [orchHistory, setOrchHistory] = useState<TranscriptEntry[]>([]);
  const [commands, setCommands] = useState<Invocable[]>([]);
  const [models, setModels] = useState<ModelChoice[]>([]);
  const panelRef = useRef<HTMLElement>(null);
  const [widths, setWidths] = useState<ColumnWidths>(loadWidths);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  /** Set when the process behind this window does not answer everything the window will ask. */
  const [staleMain, setStaleMain] = useState<string | null>(null);
  const [update, setUpdate] = useState<UpdateCheck | null>(null);
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const checkForUpdate = async () => {
    setCheckingUpdate(true);
    try {
      setUpdate(await window.relay.checkForUpdate());
    } finally {
      setCheckingUpdate(false);
    }
  };

  // once at startup, so a newer release is noticed without anyone asking
  useEffect(() => {
    void checkForUpdate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const wanted = Object.values(IPC).filter((c) => c !== IPC.sessionsChanged && c !== IPC.runnerEvent);
    window.relay.channels().then(
      (have) => {
        const missing = wanted.filter((c) => !have.includes(c));
        if (missing.length > 0) {
          setStaleMain(`This window is newer than the app process behind it (${missing.length} missing). Restart the app.`);
        }
      },
      () => setStaleMain('This window is newer than the app process behind it. Restart the app.'),
    );
  }, []);
  /** Null until the user picks one, so the app keeps following the system before then. */
  const [theme, setTheme] = useState<Theme | null>(loadTheme);
  const [allowAllActions, setAllowAllActions] = useState(false);

  useEffect(() => {
    applyTheme(theme);
    if (theme) saveTheme(theme);
  }, [theme]);

  useEffect(() => {
    void window.relay.settings().then((s) => setAllowAllActions(s.allowAllActions));
  }, []);
  const resize = (side: keyof ColumnWidths, px: number) =>
    setWidths((w) => {
      const next = { ...w, [side]: clampWidth(side, px) };
      saveWidths(next);
      return next;
    });
  const run = useRunState();
  /** The engine owns this one, so it is set there first and only then shown as on. */
  const changeAllowAll = async (on: boolean) => {
    try {
      await window.relay.setAllowAllActions(on);
      setAllowAllActions(on);
      setSettingsError(null);
    } catch (e: unknown) {
      // e.g. an app whose main process is older than this window: the control must not just sit there
      setSettingsError(e instanceof Error ? e.message : String(e));
    }
  };
  const selected = sessions.find((s) => s.id === selectedId) ?? null;
  const entries = loaded.id === selectedId ? loaded.entries : NO_ENTRIES;
  const liveEntries = selected ? (run.liveEntries[selected.id] ?? []) : [];

  useEffect(() => {
    void window.relay.listSessions().then(setSessions);
    void window.relay.orchestratorHistory().then(setOrchHistory);
    return window.relay.onSessionsChanged(setSessions);
  }, []);

  // Re-fetch only when the selected session itself changed; other sessions' activity must not
  // re-send a large transcript over IPC.
  const selectedVersion = selected ? `${selected.lastActivity}:${selected.messageCount}` : null;
  useEffect(() => {
    if (!selectedId) return;
    let cancelled = false;
    void window.relay.getTranscript(selectedId).then((t) => {
      if (!cancelled) setLoaded({ id: selectedId, entries: t });
    });
    return () => {
      cancelled = true;
    };
  }, [selectedId, selectedVersion]);

  useEffect(() => {
    setSendError(null);
    setCommands([]);
    setModels([]);
    if (!selectedId) return;
    let cancelled = false;
    // what this session can run depends on its directory, so it is asked per session
    void window.relay.listCommands(selectedId).then(
      (list) => {
        if (!cancelled) setCommands(list);
      },
      () => undefined,
    );
    void window.relay.listModels(selectedId).then(
      (list) => {
        if (!cancelled) setModels(list);
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [selectedId]);

  // A newly opened session starts at its latest turn; updates keep following it unless the user scrolled up.
  const onPanelScroll = useFollowBottom(panelRef, [entries, liveEntries, showSidechain], selectedId);

  return (
    <div className="shell">
      {/* the window has no frame of its own, so this strip is what you drag it by */}
      <div className="titlebar">
        <button type="button" className="titlebar__settings" onClick={() => setSettingsOpen(true)}>
          Settings
        </button>
      </div>
      {update?.newer && (
        <div role="status" className="update-banner">
          Relay Hub {update.latest} is available.
          {update.url && (
            <a href={update.url} target="_blank" rel="noreferrer">
              Open the release
            </a>
          )}
        </div>
      )}
      {staleMain && (
        <div role="alert" className="stale-banner">
          {staleMain}
        </div>
      )}
      {allowAllActions && (
        <div role="status" className="allow-all-banner">
          Relay is allowing every action without asking.
          <button type="button" onClick={() => void changeAllowAll(false)}>
            Turn off
          </button>
        </div>
      )}
      {run.gh.state === 'unavailable' && (
        <div role="alert" className="gh-banner">
          GitHub CLI unavailable — PR watches paused: {run.gh.message}
        </div>
      )}
      {settingsOpen && (
        <Settings
          theme={theme ?? systemTheme()}
          onTheme={setTheme}
          allowAllActions={allowAllActions}
          onAllowAllActions={(on) => void changeAllowAll(on)}
          error={settingsError}
          update={update}
          checkingUpdate={checkingUpdate}
          onCheckForUpdate={() => void checkForUpdate()}
          onClose={() => setSettingsOpen(false)}
        />
      )}
      <div
        className="app"
        style={{ gridTemplateColumns: `${widths.left}px 6px minmax(0,1fr) 6px ${widths.right}px` }}
      >
      <SessionList
        sessions={sessions}
        selectedId={selectedId}
        onSelect={setSelectedId}
        states={run.states}
        external={run.external}
        onNewSession={() => setCreating(true)}
        panel={
          creating && (
            <NewSessionForm
              listProjects={window.relay.listProjects}
              onCreate={(req) => window.relay.createSession(req)}
              onCreated={(id) => {
                setCreating(false);
                setSelectedId(id);
              }}
              onCancel={() => setCreating(false)}
            />
          )
        }
      />
      <ColumnResizer label="Resize list column" width={widths.left} side="left" onResize={(px) => resize('left', px)} />
      <main className="orchestrator" aria-label="Orchestrator">
        <OrchestratorChat
          history={orchHistory}
          liveEntries={run.liveEntries[ORCHESTRATOR_KEY] ?? []}
          state={run.states[ORCHESTRATOR_KEY]}
          onSend={(p) => void window.relay.orchestratorSend(p)}
          onInterrupt={() => void window.relay.orchestratorInterrupt()}
          bulkRuns={run.bulkRuns}
          onBulkConfirm={(id, ids) => void window.relay.bulkConfirm(id, ids).catch(() => undefined)}
          onBulkCancel={(id) => void window.relay.bulkCancel(id).catch(() => undefined)}
          approvals={run.approvals}
          sessions={sessions}
          onOpenSession={setSelectedId}
        />
        <ApprovalsDrawer
          approvals={run.approvals}
          sessions={sessions}
          onDecide={(id, d) => void window.relay.decide(id, d)}
          onOpenSession={setSelectedId}
        />
      </main>
      <ColumnResizer label="Resize detail column" width={widths.right} side="right" onResize={(px) => resize('right', px)} />
      <section className="session-panel" aria-label="Session panel" ref={panelRef} onScroll={onPanelScroll}>
        {selected ? (
          <SessionPanel
            session={selected}
            entries={entries}
            liveEntries={liveEntries}
            state={run.states[selected.id]}
            approvals={run.approvals.filter((a) => a.sessionId === selected.id)}
            showSidechain={showSidechain}
            onToggleSidechain={setShowSidechain}
            onDecide={(id, d) => void window.relay.decide(id, d)}
            onSend={(prompt, mode) =>
              void window.relay
                .send({ sessionId: selected.id, prompt, mode, origin: 'user' })
                .then(() => setSendError(null))
                .catch((e: unknown) => setSendError(e instanceof Error ? e.message : String(e)))
            }
            onInterrupt={() => void window.relay.interrupt(selected.id)}
            devTools={import.meta.env.DEV}
            watch={run.watches.find((w) => w.sessionId === selected.id && w.active) ?? null}
            onWatch={() =>
              void window.relay
                .watchCreate(selected.id)
                .then(() => setSendError(null))
                .catch((e: unknown) => setSendError(e instanceof Error ? e.message : String(e)))
            }
            onUnwatch={(id) => void window.relay.watchDelete(id)}
            heldElsewhere={run.external[selected.id] ?? null}
            models={models}
            onSetModel={(id) =>
              void window.relay
                .setModel(selected.id, id)
                .then(() => {
                  setSendError(null);
                  return window.relay.listModels(selected.id).then(setModels);
                })
                .catch((e: unknown) => setSendError(e instanceof Error ? e.message : String(e)))
            }
            onAside={(question) =>
              void window.relay
                .aside(selected.id, question)
                .then(() => setSendError(null))
                .catch((e: unknown) => setSendError(e instanceof Error ? e.message : String(e)))
            }
            onTakeOver={() =>
              void window.relay
                .takeOver(selected.id)
                .then(() => setSendError(null))
                .catch((e: unknown) => setSendError(e instanceof Error ? e.message : String(e)))
            }
            notice={sendError}
            commands={commands}
            dot={dotState(selected.id, run.states, run.external)}
          />
        ) : (
          <p className="placeholder">Select a session.</p>
        )}
      </section>
      </div>
    </div>
  );
}
