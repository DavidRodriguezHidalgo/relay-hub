import { memo, useMemo } from 'react';
import type { LiveEntry, TranscriptBlock, TranscriptEntry } from '@relay/shared';
import { Markdown } from './Markdown';

/** A file entry, or a live one that also knows who caused it. */
export type ViewEntry = TranscriptEntry & { origin?: LiveEntry['origin'] };

interface Props {
  entries: ViewEntry[];
  hideSidechain: boolean;
  /** Passed on so a session named in a reply can be opened from it. */
  sessions?: { id: string }[];
  onOpenSession?: (id: string) => void;
}

const INPUT_MAX = 120;

function Block({ block, sessions, onOpenSession }: { block: TranscriptBlock } & Pick<Props, 'sessions' | 'onOpenSession'>) {
  switch (block.kind) {
    case 'text':
      return <Markdown text={block.text} sessions={sessions} onOpenSession={onOpenSession} />;
    case 'tool_use': {
      const input = JSON.stringify(block.input) ?? '';
      return (
        <div className="block-tool">
          ▸ {block.name} {input.length > INPUT_MAX ? `${input.slice(0, INPUT_MAX)}…` : input}
        </div>
      );
    }
    case 'tool_result': {
      const [first = '', ...rest] = block.text.split('\n');
      // a one-line result (e.g. a JSON payload) is summarised short and shown whole when opened
      const clipped = first.length > INPUT_MAX;
      const body = clipped ? block.text : rest.join('\n');
      return (
        <details className={block.isError ? 'block-result block-result--error' : 'block-result'}>
          <summary>{clipped ? `${first.slice(0, INPUT_MAX)}…` : first}</summary>
          {body.length > 0 && <pre>{body}</pre>}
        </details>
      );
    }
    case 'image':
      return <p className="block-text">[image]</p>;
    case 'thinking':
      return null;
  }
}

/** One card. Memoised so that typing elsewhere does not re-render every entry on screen. */
const EntryRow = memo(function EntryRow({
  entry,
  sessions,
  onOpenSession,
}: { entry: ViewEntry } & Pick<Props, 'sessions' | 'onOpenSession'>) {
  return (
    <li className={`entry entry--${entry.role}${entry.isSidechain ? ' entry--sidechain' : ''}`}>
      <header>
        <span>{entry.role}</span>
        {entry.origin && <span className="origin">{entry.origin}</span>}
        <time dateTime={entry.timestamp}>{new Date(entry.timestamp).toLocaleTimeString()}</time>
      </header>
      {entry.blocks.map((b, i) => (
        <Block key={i} block={b} sessions={sessions} onOpenSession={onOpenSession} />
      ))}
    </li>
  );
});

export function TranscriptView({ entries, hideSidechain, sessions, onOpenSession }: Props) {
  // thinking is never shown, so a frame holding only thinking would be an empty card
  const visible = useMemo(
    () =>
      entries.filter(
        (e) => !e.isMeta && (!hideSidechain || !e.isSidechain) && e.blocks.some((b) => b.kind !== 'thinking'),
      ),
    [entries, hideSidechain],
  );
  return (
    <ol className="transcript">
      {visible.map((e) => (
        <EntryRow key={e.uuid} entry={e} sessions={sessions} onOpenSession={onOpenSession} />
      ))}
    </ol>
  );
}
