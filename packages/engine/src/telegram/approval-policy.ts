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

/** Push flags that overwrite or delete without a lease. */
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
