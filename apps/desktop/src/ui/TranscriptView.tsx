import type { LiveEntry, TranscriptBlock, TranscriptEntry } from '@relay/shared';

/** A file entry, or a live one that also knows who caused it. */
export type ViewEntry = TranscriptEntry & { origin?: LiveEntry['origin'] };

interface Props {
  entries: ViewEntry[];
  hideSidechain: boolean;
}

const INPUT_MAX = 120;

function Block({ block }: { block: TranscriptBlock }) {
  switch (block.kind) {
    case 'text':
      return <p className="block-text">{block.text}</p>;
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
      return (
        <details className={block.isError ? 'block-result block-result--error' : 'block-result'}>
          <summary>{first}</summary>
          {rest.length > 0 && <pre>{rest.join('\n')}</pre>}
        </details>
      );
    }
    case 'image':
      return <p className="block-text">[image]</p>;
    case 'thinking':
      return null;
  }
}

export function TranscriptView({ entries, hideSidechain }: Props) {
  const visible = entries.filter((e) => !e.isMeta && (!hideSidechain || !e.isSidechain));
  return (
    <ol className="transcript">
      {visible.map((e) => (
        <li key={e.uuid} className={`entry entry--${e.role}${e.isSidechain ? ' entry--sidechain' : ''}`}>
          <header>
            <span>{e.role}</span>
            {e.origin && <span className="origin">{e.origin}</span>}
            <time dateTime={e.timestamp}>{new Date(e.timestamp).toLocaleTimeString()}</time>
          </header>
          {e.blocks.map((b, i) => (
            <Block key={i} block={b} />
          ))}
        </li>
      ))}
    </ol>
  );
}
