import { useState } from 'react';
import type { ApprovalDecision, PendingApproval } from '@relay/shared';

interface Props {
  approval: PendingApproval;
  onDecide: (id: string, decision: ApprovalDecision) => void;
}

const REASONS: Record<PendingApproval['reason'], string> = {
  'destructive-git': 'Destructive git command',
  'outside-cwd': 'Touches a path outside the session directory',
  'blocked-path': 'Path blocked by Claude Code',
};

/** A command longer than this is folded away: the card has to stay readable next to the chat. */
const SUMMARY_LINES = 6;

export function ApprovalCard({ approval, onDecide }: Props) {
  const [expanded, setExpanded] = useState(false);
  const lines = approval.summary.split('\n');
  const folded = lines.length > SUMMARY_LINES;
  const shown = folded && !expanded ? `${lines.slice(0, SUMMARY_LINES).join('\n')}\n…` : approval.summary;
  /** One decision per approval: a second click would be refused by the engine anyway. */
  const [decided, setDecided] = useState(false);
  const decide = (d: ApprovalDecision) => {
    if (decided) return;
    setDecided(true);
    onDecide(approval.id, d);
  };
  return (
    <div className="approval" role="group" aria-label="Approval">
      <div className="approval__reason">{REASONS[approval.reason]}</div>
      <code className="approval__summary">{shown}</code>
      {folded && (
        <button type="button" className="approval__more" onClick={() => setExpanded(!expanded)}>
          {expanded ? 'Show less' : `Show all ${lines.length} lines`}
        </button>
      )}
      <div className="approval__meta">
        {approval.toolName} · {approval.cwd}
      </div>
      <div className="approval__actions">
        <button type="button" className="btn-primary" disabled={decided} onClick={() => decide({ kind: 'allow-once' })}>
          Allow once
        </button>
        <button type="button" disabled={decided} onClick={() => decide({ kind: 'deny' })}>
          Deny
        </button>
        <button type="button" disabled={decided} onClick={() => decide({ kind: 'allow-pattern' })}>
          Always allow this kind
        </button>
      </div>
    </div>
  );
}
