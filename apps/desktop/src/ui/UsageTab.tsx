import { resetWording, usageLevel, type AccountUsage, type UsageWindow } from '@relay/shared';

interface Props {
  usage: AccountUsage | null;
  now: Date;
  onRefresh: () => void;
  refreshing: boolean;
}

const WINDOW_NAME: Record<UsageWindow['kind'], string> = {
  'five-hour': 'Current session',
  'seven-day': 'This week',
};

const WINDOW_NOTE: Record<UsageWindow['kind'], string> = {
  'five-hour': 'A rolling window. This is the one that ends a session mid-task.',
  'seven-day': 'Resets weekly, across every session on this account.',
};

/**
 * What is left of the account's allowance, and where the number comes from.
 *
 * The account is not a session, so this lives in Settings rather than in any one conversation.
 * The provenance line is not padding: the figure comes from an API Claude Code marks as
 * experimental, and that is worth knowing before anyone plans a day around it.
 */
export function UsageTab({ usage, now, onRefresh, refreshing }: Props) {
  return (
    <section className="settings__section" aria-label="Usage limits">
      <h3>Usage limits{usage?.plan ? <span className="usage__plan"> {usage.plan}</span> : null}</h3>

      {!usage && <p className="settings__note">Checking how much of your usage limit is left…</p>}

      {usage && !usage.available && (
        <p className="settings__note">
          Relay cannot read your usage limits from Claude Code on this machine, so it is not showing
          a number. It will try again; nothing here is inferred or remembered from an earlier reading.
        </p>
      )}

      {usage?.available &&
        usage.windows.map((w) => (
          <div key={w.kind} className="usage-row">
            <div className="usage-row__head">
              <span className="usage-row__name">{WINDOW_NAME[w.kind]}</span>
              <span className="usage-row__percent">{w.percent}% used</span>
            </div>
            <div
              className="usage-bar"
              role="meter"
              aria-label={`${WINDOW_NAME[w.kind]} usage`}
              aria-valuenow={w.percent}
              aria-valuemin={0}
              aria-valuemax={100}
            >
              <div className={`usage-bar__fill usage-bar__fill--${usageLevel(w.percent)}`} style={{ width: `${w.percent}%` }} />
            </div>
            <p className="settings__note">
              Resets {resetWording(w.resetsAt, now)}. {WINDOW_NOTE[w.kind]}
            </p>
          </div>
        ))}

      <p className="settings__note">
        These come straight from Claude Code — nothing here is estimated or inferred from what your
        sessions have done. It reports two windows and Relay shows both; it also carries per-model
        weekly buckets, which were empty on this account, so Relay does not show them rather than
        guess which model each belongs to. The call behind this is one Claude Code marks as
        experimental, so an update to it can leave Relay unable to read these — it will say so here
        rather than keep showing the last number.
      </p>

      <p className="settings__row">
        <button type="button" onClick={onRefresh} disabled={refreshing}>
          {refreshing ? 'Checking…' : 'Check now'}
        </button>
        {usage?.checkedAt && (
          <span className="settings__note"> Last read {resetWording(usage.checkedAt, now)}.</span>
        )}
      </p>
    </section>
  );
}
