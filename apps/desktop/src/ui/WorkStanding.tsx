import type { SessionStatus } from '@relay/shared';

/** Checks the forge reports as failed, by its own wording. */
const FAILED = ['FAILURE', 'ERROR', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE'];
const PASSED = ['SUCCESS', 'NEUTRAL', 'SKIPPED'];

const kindOf = (conclusion: string): 'passed' | 'failed' | 'pending' => {
  const c = conclusion.toUpperCase();
  if (FAILED.includes(c)) return 'failed';
  if (PASSED.includes(c)) return 'passed';
  return 'pending';
};

/**
 * What can be checked about a session's work, rather than what it claimed.
 *
 * Everything here is read from git or the pull request. When there are no checks to report it
 * says why, since a blank space reads like a pass.
 */
export function WorkStanding({ status }: { status: SessionStatus | null }) {
  if (!status) return null;
  const failed = status.checks?.filter((c) => kindOf(c.conclusion) === 'failed') ?? [];
  const passed = status.checks?.filter((c) => kindOf(c.conclusion) === 'passed') ?? [];
  const pending = status.checks?.filter((c) => kindOf(c.conclusion) === 'pending') ?? [];
  return (
    <section className="standing" aria-label="Where this stands">
      <h2 className="standing__heading">Where this stands</h2>
      <p className="standing__commit">
        {status.lastCommit ? (
          <>
            <code>{status.lastCommit.sha.slice(0, 7)}</code> {status.lastCommit.subject}
          </>
        ) : (
          'No commits yet.'
        )}
      </p>
      <p className="standing__git">
        {status.uncommitted > 0 && <span className="standing__warn">{status.uncommitted} uncommitted</span>}
        {status.uncommitted > 0 && (status.unpushed > 0 || status.upstream !== null) && ' · '}
        {status.unpushed > 0 ? (
          <span className="standing__warn">{status.unpushed} unpushed</span>
        ) : (
          status.upstream !== null && <span>pushed to {status.upstream}</span>
        )}
        {status.upstream === null && status.unpushed === 0 && status.uncommitted === 0 && <span>nothing to push</span>}
      </p>
      {status.checks && status.checks.length > 0 && (
        <p className="standing__checks">
          {failed.length > 0 ? (
            <span className="standing__failed">
              {failed.length} failed: {failed.map((c) => c.name).join(', ')}
            </span>
          ) : (
            <span className="standing__passed">{passed.length} passed</span>
          )}
          {pending.length > 0 && <span className="standing__pending"> · {pending.length} still running</span>}
        </p>
      )}
      {status.note && <p className="standing__note">{status.note}</p>}
      {status.pr && (
        <p className="standing__pr">
          <a href={status.pr.url} target="_blank" rel="noreferrer">
            PR #{status.pr.number}
          </a>{' '}
          {status.pr.state.toLowerCase()}
        </p>
      )}
    </section>
  );
}
