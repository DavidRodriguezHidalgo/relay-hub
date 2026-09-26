import { useEffect, useRef, useState } from 'react';
import type { Accomplished as AccomplishedWork } from '@relay/shared';
import {
  IPC,
  ORCHESTRATOR_KEY,
  type Invocable,
  type SessionSummary,
  type TranscriptEntry,
  type UpdateCheck,
  type ModelChoice,
  type SessionStatus,
  type CheckoutPlan,
  type CheckoutResult,
  type UpdateMode,
  type Screenshot,
} from '@relay/shared';
import { ApprovalsDrawer } from './ApprovalsDrawer';
import { collisionFor } from './collisions';
import { stalenessOf } from './staleness';
import { dismissedCollisions, dismissCollision } from './dismissed';
import { ColumnResizer } from './ColumnResizer';
import { Settings } from './Settings';
import { applyTheme, loadTheme, saveTheme, systemTheme, type Theme } from './theme';
import { clampWidth, loadWidths, saveWidths, type ColumnWidths } from './columnWidths';
import { NewSessionForm } from './NewSessionForm';
import { OrchestratorChat } from './OrchestratorChat';
import { SessionList } from './SessionList';
import { TodoList } from './TodoList';
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
  /** Sessions a stop has been asked for, until their turn actually ends. */
  const [stopping, setStopping] = useState<string[]>([]);
  const [creating, setCreating] = useState(false);
  const [orchHistory, setOrchHistory] = useState<TranscriptEntry[]>([]);
  const [commands, setCommands] = useState<Invocable[]>([]);
  const [models, setModels] = useState<ModelChoice[]>([]);
  const [standing, setStanding] = useState<SessionStatus | null>(null);
  const [accomplished, setAccomplished] = useState<AccomplishedWork | null>(null);
  const panelRef = useRef<HTMLElement>(null);
  const [widths, setWidths] = useState<ColumnWidths>(loadWidths);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  /** Set when the process behind this window does not answer everything the window will ask. */
  /** Channels the app process does not answer; 0 once it has been asked and agreed. */
  const [missingChannels, setMissingChannels] = useState(0);
  /** The session as this window drew it, to compare with what the index says now. */
  const [shownSession, setShownSession] = useState<SessionSummary | null>(null);
  const [dismissed, setDismissed] = useState<string[]>(dismissedCollisions);
  const [projects, setProjects] = useState<{ name: string; root: string; sessions: number }[]>([]);
  const [shots, setShots] = useState<Screenshot[]>([]);
  const [update, setUpdate] = useState<UpdateCheck | null>(null);
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [downloadedTo, setDownloadedTo] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [updateMode, setUpdateMode] = useState<UpdateMode>('packaged');
  const [checkoutPlan, setCheckoutPlan] = useState<CheckoutPlan | null>(null);
  const [checkoutResult, setCheckoutResult] = useState<CheckoutResult | null>(null);
  const [pulling, setPulling] = useState(false);
  const pull = async () => {
    setPulling(true);
    try {
      setCheckoutResult(await window.relay.applyCheckout());
      setCheckoutPlan(await window.relay.checkoutPlan());
    } catch (e: unknown) {
      setCheckoutResult({ pulled: [], installed: false, error: e instanceof Error ? e.message : String(e) });
    } finally {
      setPulling(false);
    }
  };
  const downloadUpdate = async () => {
    if (!update?.assetUrl || !update.assetName) return;
    setDownloading(true);
    setDownloadError(null);
    try {
      setDownloadedTo(await window.relay.downloadUpdate(update.assetUrl, update.assetName));
    } catch (e: unknown) {
      setDownloadError(e instanceof Error ? e.message : String(e));
    } finally {
      setDownloading(false);
    }
  };
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
    // a working copy is pulled, a packaged build replaced: only the right one is offered
    void window.relay.updateMode().then((mode) => {
      setUpdateMode(mode);
      if (mode === 'checkout') void window.relay.checkoutPlan().then(setCheckoutPlan, () => undefined);
    }, () => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const wanted = Object.values(IPC).filter((c) => c !== IPC.sessionsChanged && c !== IPC.runnerEvent);
    window.relay.channels().then(
      (have) => {
        setMissingChannels(wanted.filter((c) => !have.includes(c)).length);
      },
      () => setMissingChannels(1),
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
  const selectedState = selected ? run.states[selected.id]?.state : undefined;
  useEffect(() => {
    if (selectedState !== 'running' && selectedState !== 'waiting-approval') {
      setStopping((ids) => (selected && ids.includes(selected.id) ? ids.filter((i) => i !== selected.id) : ids));
    }
  }, [selectedState, selected]);

  const stale = stalenessOf({
    missingChannels,
    shown: shownSession,
    current: selected,
  });
  const liveEntries = selected ? (run.liveEntries[selected.id] ?? []) : [];

  useEffect(() => {
    void window.relay.listSessions().then(setSessions);
    void window.relay.orchestratorHistory().then(setOrchHistory);
    void window.relay.listProjects().then(setProjects, () => undefined);
    return window.relay.onSessionsChanged(setSessions);
  }, []);

  // Re-fetch only when the selected session itself changed; other sessions' activity must not
  // re-send a large transcript over IPC.
  const selectedVersion = selected ? `${selected.lastActivity}:${selected.messageCount}` : null;
  useEffect(() => {
    if (!selectedId) return;
    let cancelled = false;
    void window.relay.getTranscript(selectedId).then((t) => {
      if (!cancelled) {
        setLoaded({ id: selectedId, entries: t });
        setShownSession(sessions.find((x) => x.id === selectedId) ?? null);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [selectedId, selectedVersion]);

  useEffect(() => {
    setSendError(null);
    setCommands([]);
    setModels([]);
    setStanding(null);
    setAccomplished(null);
    setShots([]);
    if (!selectedId) return;
    let cancelled = false;
    // what this session can run depends on its directory, so it is asked per session
    void window.relay.listCommands(selectedId).then(
      (list) => {
        if (!cancelled) setCommands(list);
      },
      () => undefined,
    );
    void window.relay.accomplished(selectedId).then(
      (w) => {
        if (!cancelled) setAccomplished(w);
      },
      () => undefined,
    );
    void window.relay.sessionStatus(selectedId).then(
      (s) => {
        if (!cancelled) setStanding(s);
      },
      () => undefined,
    );
    void window.relay.screenshots(selectedId).then(
      (list) => {
        if (!cancelled) setShots(list);
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
      {stale && (
        <div role="alert" className="stale-banner">
          {stale.message}
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
          downloadedTo={downloadedTo}
          downloading={downloading}
          downloadError={downloadError}
          onDownloadUpdate={() => void downloadUpdate()}
          updateMode={updateMode}
          checkoutPlan={checkoutPlan}
          checkoutResult={checkoutResult}
          pulling={pulling}
          onPull={() => void pull()}
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
        onInterrupt={(id) => {
          setStopping((ids) => (ids.includes(id) ? ids : [...ids, id]));
          void window.relay.interrupt(id).catch(() => undefined);
        }}
        header={
          <TodoList
            todos={run.todos}
            sessions={sessions}
            projects={projects}
            states={run.states}
            external={run.external}
            onCreate={(draft) => window.relay.createTodo(draft)}
            onUpdate={(id, patch) => window.relay.updateTodo(id, patch)}
            onDelete={(id) => window.relay.deleteTodo(id)}
            onLaunch={(id) => window.relay.launchTodo(id).then((r) => setSelectedId(r.sessionId))}
            onAttach={(id, sessionId) => window.relay.attachTodo(id, sessionId)}
            onDetach={(id) => window.relay.detachTodo(id)}
            onMove={(id, direction) => window.relay.moveTodo(id, direction)}
            onOpenSession={setSelectedId}
          />
        }
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
            stopping={stopping.includes(selected.id)}
            onInterrupt={() => {
              setStopping((ids) => (ids.includes(selected.id) ? ids : [...ids, selected.id]));
              void window.relay.interrupt(selected.id).catch(() => undefined);
            }}
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
            collision={(() => {
              const hit = collisionFor(sessions, selected.id, { states: run.states, external: run.external, now: Date.now() });
              return hit && dismissed.includes(hit.key) ? null : hit;
            })()}
            onNewWorktree={() => setCreating(true)}
            onDismissCollision={() => {
              const hit = collisionFor(sessions, selected.id, { states: run.states, external: run.external, now: Date.now() });
              if (hit) setDismissed(dismissCollision(hit.key));
            }}
            standing={standing}
            accomplished={accomplished}
            screenshots={shots}
            contextUse={selected.context}
            queue={run.queue[selected.id] ?? []}
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
