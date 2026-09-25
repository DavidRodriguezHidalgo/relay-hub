import { AbsoluteFill, interpolate, Sequence, useCurrentFrame } from 'remotion';
import './ui.css';

export const FPS = 30;
/** Five scenes, about forty-five seconds. */
export const DURATION = 45 * FPS;

type State = 'idle' | 'running' | 'waiting-approval' | 'elsewhere';

interface Session {
  title: string;
  branch: string;
  state: State;
}

/** Invented, and deliberately generic: nothing here is anyone's real work. */
const SESSIONS: Session[] = [
  { title: 'Add pagination to the items API', branch: 'feat/items-pagination', state: 'running' },
  { title: 'Fix flaky checkout test', branch: 'fix/checkout-flake', state: 'waiting-approval' },
  { title: 'Upgrade the UI toolkit', branch: 'chore/ui-toolkit', state: 'idle' },
  { title: 'Rewrite the onboarding guide', branch: 'docs/onboarding', state: 'elsewhere' },
];

const fade = (frame: number, from: number, span = 12) =>
  interpolate(frame, [from, from + span], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });

const rise = (frame: number, from: number, span = 12) =>
  interpolate(frame, [from, from + span], [12, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });

function SessionList({ selected, extraRunning }: { selected: number; extraRunning: boolean }) {
  const frame = useCurrentFrame();
  return (
    <div className="session-list">
      <h2>example-repo</h2>
      <ul>
        {SESSIONS.map((s, i) => {
          const state: State = extraRunning && i === 2 ? 'running' : s.state;
          return (
            <li
              key={s.title}
              className={i === selected ? 'session-item session-item--selected' : 'session-item'}
              style={{ opacity: fade(frame, 6 + i * 4) }}
            >
              <span className="session-item__title">
                <span className={`dot dot--${state}`} />
                {s.title}
              </span>
              <span className="session-item__meta">{s.branch}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function WorkingLine({ seconds }: { seconds: number }) {
  return (
    <div className="working">
      <p className="working__head">
        <span className="working__mark">✳</span> Percolating… <span className="working__meta">({seconds}s · still thinking)</span>
      </p>
      <p className="working__tip">Tip: press / in the box below to run one of this session’s commands.</p>
    </div>
  );
}

function Chat({ sent, reported, opening }: { sent: boolean; reported: boolean; opening?: boolean }) {
  const frame = useCurrentFrame();
  return (
    <div className="orchestrator">
      <header className="chat__header">
        <strong>Relay</strong>
        <span className={`state state--${sent && !reported ? 'running' : 'idle'}`}>{sent && !reported ? 'running' : 'idle'}</span>
      </header>
      {opening && (
        <div className="entry entry--user">
          <header>
            <span>you</span>
          </header>
          What is running?
        </div>
      )}
      {opening && (
        <div className="entry" style={{ opacity: fade(frame, 18) }}>
          Two sessions are working: <strong>Add pagination to the items API</strong> and <strong>Upgrade the UI
          toolkit</strong>. <strong>Fix flaky checkout test</strong> is waiting on an approval.
        </div>
      )}
      {sent && (
        <div className="entry entry--user" style={{ opacity: fade(frame, 0), transform: `translateY(${rise(frame, 0)}px)` }}>
          <header>
            <span>you</span>
          </header>
          Ask the pagination session to add tests for the empty page.
        </div>
      )}
      {sent && (
        <div className="entry" style={{ opacity: fade(frame, 14) }}>
          Sending to <strong>Add pagination to the items API</strong> (feat/items-pagination).
        </div>
      )}
      {reported && (
        <div className="relay-update" style={{ opacity: fade(frame, 0) }}>
          [turn-end] session “Fix flaky checkout test” finished. Last reply: the test now seeds its own
          fixtures, so it no longer depends on run order.
        </div>
      )}
      {reported && (
        <div className="entry" style={{ opacity: fade(frame, 12) }}>
          The checkout test is fixed and pushed. The pagination session is still working.
        </div>
      )}
    </div>
  );
}

function Panel({
  session,
  queued,
  working,
  seconds,
  standing,
}: {
  session: Session;
  queued?: string;
  working?: boolean;
  seconds?: number;
  standing?: boolean;
}) {
  const frame = useCurrentFrame();
  return (
    <div className="session-panel">
      <h1>{session.title}</h1>
      <p className="session-panel__meta">
        <span className={`dot dot--${working ? 'running' : 'idle'}`} />
        <code>~/code/example-repo</code> <code>{session.branch}</code>
      </p>
      {standing && (
        <div className="standing" style={{ opacity: fade(frame, 4) }}>
          <p className="standing__heading">Where this stands</p>
          <p className="standing__commit">
            <code>4f1c2ab</code> seed fixtures in the checkout test
          </p>
          <p className="standing__git">pushed to origin/fix/checkout-flake</p>
          <p className="standing__checks">
            <span className="standing__passed">3 passed</span>
          </p>
        </div>
      )}
      {queued && (
        <div className="queue" style={{ opacity: fade(frame, 0), transform: `translateY(${rise(frame, 0)}px)` }}>
          <p className="queue__heading">1 instruction waiting to be answered</p>
          <ul className="queue__list">
            <li className="queue__item">
              <span className="queue__origin">orchestrator</span> {queued}
            </li>
          </ul>
        </div>
      )}
      {working && <WorkingLine seconds={seconds ?? 0} />}
    </div>
  );
}

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div className="shell">
      <div className="titlebar" />
      <div className="app">{children}</div>
    </div>
  );
}

function Caption({ at, text, sub }: { at: number; text: string; sub?: string }) {
  const frame = useCurrentFrame();
  return (
    <div className="caption" style={{ opacity: fade(frame, at) }}>
      {text}
      {sub && <small>{sub}</small>}
    </div>
  );
}

export const Orchestration: React.FC = () => {
  // the app follows the system, and a headless browser says light; the product is dark
  document.documentElement.dataset.theme = 'dark';
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill style={{ background: 'var(--bg)' }}>
      {/* 1. what it is */}
      <Sequence durationInFrames={4 * FPS}>
        <AbsoluteFill style={{ background: 'var(--bg)' }}>
          <div className="title">
            <h1 style={{ opacity: fade(frame, 4) }}>Relay Hub</h1>
            <p style={{ opacity: fade(frame, 16) }}>Several Claude Code sessions. One place.</p>
          </div>
        </AbsoluteFill>
      </Sequence>

      {/* 2. many sessions, each in its own state */}
      <Sequence from={4 * FPS} durationInFrames={9 * FPS}>
        <Frame>
          <SessionList selected={0} extraRunning={false} />
          <div className="resizer" />
          <Chat sent={false} reported={false} opening />
          <div className="resizer" />
          <Panel session={SESSIONS[0]!} working seconds={18} />
        </Frame>
        <Caption at={30} text="Every session you have, and what each is doing" sub="working · waiting on you · idle · open in a terminal" />
      </Sequence>

      {/* 3. sending work to one of them */}
      <Sequence from={13 * FPS} durationInFrames={11 * FPS}>
        <Frame>
          <SessionList selected={0} extraRunning={false} />
          <div className="resizer" />
          <Chat sent reported={false} />
          <div className="resizer" />
          <Panel session={SESSIONS[0]!} queued="Add tests for the empty page." working seconds={24} />
        </Frame>
        <Caption at={40} text="Ask in one chat; it goes to the right session" sub="queued behind the work already in flight" />
      </Sequence>

      {/* 4. another session reports back on its own */}
      <Sequence from={24 * FPS} durationInFrames={12 * FPS}>
        <Frame>
          <SessionList selected={1} extraRunning />
          <div className="resizer" />
          <Chat sent={false} reported />
          <div className="resizer" />
          <Panel session={SESSIONS[1]!} standing />
        </Frame>
        <Caption at={40} text="They report back when they finish" sub="with the commit, and what CI said about it" />
      </Sequence>

      {/* 5. the point */}
      <Sequence from={36 * FPS}>
        <Frame>
          <SessionList selected={2} extraRunning />
          <div className="resizer" />
          <Chat sent={false} reported={false} />
          <div className="resizer" />
          <Panel session={SESSIONS[2]!} working seconds={6} />
        </Frame>
        <Caption at={20} text="Orchestration, not one chat at a time" />
      </Sequence>
    </AbsoluteFill>
  );
};
