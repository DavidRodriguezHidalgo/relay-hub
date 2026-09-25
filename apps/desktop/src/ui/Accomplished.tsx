import type { Accomplished as Work } from '@relay/shared';

/**
 * What a session produced, in the terms someone asks about it: commits, files, what is open.
 *
 * Test status is deliberately absent — it belongs to the pull request and is shown above by
 * "Where this stands", read from the forge rather than claimed here twice.
 */
export function Accomplished({ work }: { work: Work | null }) {
  if (!work) return null;
  const nothing = work.commits.length === 0 && work.files.length === 0 && work.open.length === 0;
  return (
    <section className="done" aria-label="What this accomplished">
      <h2 className="done__heading">What this accomplished</h2>
      {nothing && <p className="done__none">{work.note ?? 'Nothing committed or changed yet.'}</p>}

      {work.commits.length > 0 && (
        <ul className="done__commits">
          {work.commits.map((c) => (
            <li key={c.sha}>
              <code>{c.sha.slice(0, 7)}</code> {c.subject}
            </li>
          ))}
        </ul>
      )}

      {work.files.length > 0 && (
        <p className="done__files">
          {work.files.length + work.moreFiles} file{work.files.length + work.moreFiles === 1 ? '' : 's'} touched:{' '}
          <span className="done__names">{work.files.join(', ')}</span>
          {work.moreFiles > 0 && <span className="done__more"> and {work.moreFiles} more</span>}
        </p>
      )}

      {work.open.length > 0 && (
        <ul className="done__open">
          {work.open.map((o) => (
            <li key={o}>{o}</li>
          ))}
        </ul>
      )}

      {work.note && !nothing && <p className="done__note">{work.note}</p>}
    </section>
  );
}
