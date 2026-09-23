import type { ApprovalDecision, PendingApproval, SessionSummary } from '@relay/shared';
import { ApprovalCard } from './ApprovalCard';

interface Props {
  approvals: PendingApproval[];
  sessions: SessionSummary[];
  onDecide: (id: string, decision: ApprovalDecision) => void;
  onOpenSession: (id: string) => void;
}

/** Every pending approval across sessions; lives under the orchestrator column. */
export function ApprovalsDrawer({ approvals, sessions, onDecide, onOpenSession }: Props) {
  if (approvals.length === 0) return null;
  const title = (id: string) => sessions.find((s) => s.id === id)?.title ?? id;
  return (
    <aside className="approvals-drawer" aria-label="Approvals">
      <h2>
        {approvals.length} {approvals.length === 1 ? 'approval' : 'approvals'} pending
      </h2>
      {approvals.map((a) => (
        <div key={a.id} className="approvals-drawer__item">
          <button type="button" className="link" onClick={() => onOpenSession(a.sessionId)}>
            {title(a.sessionId)}
          </button>
          <ApprovalCard approval={a} onDecide={onDecide} />
        </div>
      ))}
    </aside>
  );
}
