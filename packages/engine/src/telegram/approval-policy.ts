import type { PendingApproval } from '@relay/shared';
import { destructiveSteps } from '../approvals/rules';

/**
 * Whether an approval may be *allowed* from a phone. Denying is always fine.
 *
 * From a phone you see the command and nothing else: not the transcript, not the diff, not
 * which branch is checked out. So only steps whose damage is local and recoverable from the
 * reflog qualify: a rebase, an amend, or a push guarded by `--force-with-lease`. Anything
 * that deletes files or can overwrite work you have not seen waits for the machine.
 */
export type PhoneVerdict = { allowOnce: true } | { allowOnce: false; why: string };

const AT_MACHINE = 'decide it at the machine';

/**
 * The most of a command that is shown on the phone, and so the most that may be allowed.
 *
 * Allowing is allowing the whole line, not the part that made Relay ask: `git rebase main && curl
 * … | sh` is one approval. Past this length the message is clipped, so the tail cannot be read —
 * and a decision about text you were never shown is not a decision. Kept in step with
 * `COMMAND_MAX` in notifications.ts, which does the clipping.
 */
export const PHONE_COMMAND_MAX = 1500;

/**
 * Push flags that overwrite or delete without a lease.
 *
 * Deliberately not the same list as `destructiveKey` in ../approvals/rules.ts, and the difference
 * is the point: that one decides whether to *ask* and counts `--force-with-lease` as destructive;
 * this one decides whether a phone may *say yes*, and a lease is exactly what makes that safe.
 * Change one and look at the other.
 */
const unguarded = (t: string) =>
  t === '--force' || t === '-f' || t === '-d' || t === '--delete' || t === '--mirror' || t.startsWith('+') || (t.startsWith(':') && t.length > 1);

const refuse = (why: string): PhoneVerdict => ({ allowOnce: false, why });

export function phoneApprovalVerdict(approval: PendingApproval): PhoneVerdict {
  if (approval.reason === 'outside-cwd') return refuse(`it reaches outside the session's folder; ${AT_MACHINE}`);
  if (approval.reason === 'blocked-path') return refuse(`the path is blocked; ${AT_MACHINE}`);
  const command = approval.input.command;
  if (approval.toolName !== 'Bash' || typeof command !== 'string') {
    return refuse(`only a shell command can be read from a phone; ${AT_MACHINE}`);
  }
  if (command.length > PHONE_COMMAND_MAX || approval.summary.length > PHONE_COMMAND_MAX) {
    return refuse(`it is too long to show in full on a phone; ${AT_MACHINE}`);
  }
  const steps = destructiveSteps(command);
  if (steps.length === 0) return refuse(`Relay cannot tell what this does; ${AT_MACHINE}`);
  for (const step of steps) {
    switch (step.key) {
      case 'git rebase':
      case 'git commit':
        continue;
      case 'git push':
        if (step.args.some(unguarded)) return refuse(`a plain force push can overwrite work; ${AT_MACHINE}`);
        continue;
      default:
        if (step.key.startsWith('rm')) return refuse(`rm -rf deletes files; ${AT_MACHINE}`);
        return refuse(`${step.key} is not recoverable from a phone; ${AT_MACHINE}`);
    }
  }
  return { allowOnce: true };
}
