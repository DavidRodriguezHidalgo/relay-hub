import { useEffect, useState } from 'react';

/** Said while a session is mid-turn; one is picked per run, the way Claude Code does it. */
const WORDS = [
  'Infusing',
  'Pondering',
  'Percolating',
  'Noodling',
  'Simmering',
  'Conjuring',
  'Whirring',
  'Tinkering',
  'Untangling',
  'Brewing',
];

const TIPS = [
  'Press / in the box below to run one of this session’s commands.',
  'Shift+Enter starts a new line; Enter sends.',
  'Take over stops the Claude that has a session open elsewhere.',
  'Steer reaches a running turn; queue waits for it to finish.',
  'Watch PR wakes this session when its checks fail or someone reviews it.',
];

const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(Math.random() * xs.length)]!;

interface Props {
  /** Fixed wording, for tests; otherwise one is chosen per run. */
  word?: string;
  tip?: string;
}

/** Counts up while a session works, so a long turn does not look like a hung one. */
export function WorkingLine({ word, tip }: Props) {
  const [chosen] = useState(() => ({ word: word ?? pick(WORDS), tip: tip ?? pick(TIPS) }));
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, []);
  return (
    <div className="working" role="status">
      <p className="working__line">
        <span className="working__mark" aria-hidden="true">
          ✳
        </span>{' '}
        {chosen.word}… <span className="working__meta">({seconds}s · still thinking)</span>
      </p>
      <p className="working__tip">Tip: {chosen.tip}</p>
    </div>
  );
}
