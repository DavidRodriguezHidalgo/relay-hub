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

export function ApprovalCard({ approval, onDecide }: Props) {
  return (
    <div className="approval" role="group" aria-label="Approval">
      <div className="approval__reason">{REASONS[approval.reason]}</div>
      <code className="approval__summary">{approval.summary}</code>
      <div className="approval__meta">
        {approval.toolName} · {approval.cwd}
      </div>
      <div className="approval__actions">
        <button type="button" className="btn-primary" onClick={() => onDecide(approval.id, { kind: 'allow-once' })}>
          Allow once
        </button>
        <button type="button" onClick={() => onDecide(approval.id, { kind: 'deny' })}>
          Deny
        </button>
        <button type="button" onClick={() => onDecide(approval.id, { kind: 'allow-pattern' })}>
          Allow this kind for this run
        </button>
      </div>
    </div>
  );
}
