import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

/**
 * An agent's reply, rendered as the Markdown it is written in.
 *
 * Raw HTML in the text is never interpreted — it is shown as the characters it is made of —
 * and links open in the browser rather than navigating the app away from itself.
 */
export function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => (
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
}
