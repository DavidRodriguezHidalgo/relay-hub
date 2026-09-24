import { memo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { remarkSessionLinks, SESSION_HREF } from './sessionLinks';

/**
 * An agent's reply, rendered as the Markdown it is written in.
 *
 * Raw HTML in the text is never interpreted — it is shown as the characters it is made of —
 * and links open in the browser rather than navigating the app away from itself.
 */
interface Props {
  text: string;
  /** Sessions whose ids should become links; without these, ids stay plain text. */
  sessions?: { id: string }[];
  onOpenSession?: (id: string) => void;
}

/**
 * Parsing costs real time, and a transcript holds hundreds of these, so an unchanged
 * reply is never parsed again — without this, every keystroke in a message box pays for
 * re-rendering the whole transcript.
 */
export const Markdown = memo(function Markdown({ text, sessions, onOpenSession }: Props) {
  const plugins = sessions && sessions.length > 0 ? [remarkGfm, remarkSessionLinks(sessions)] : [remarkGfm];
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={plugins}
        components={{
          a: ({ href, children }) =>
            href?.startsWith(SESSION_HREF) ? (
              <button
                type="button"
                className="session-link"
                onClick={() => onOpenSession?.(href.slice(SESSION_HREF.length))}
              >
                {children}
              </button>
            ) : (
              <a href={href} target="_blank" rel="noreferrer">
                {children}
              </a>
            ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});
