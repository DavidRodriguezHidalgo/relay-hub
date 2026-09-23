import type { ExternalSessions, RunState } from '@relay/shared';

export const DOT_LABEL: Record<string, string> = {
  idle: 'idle',
  running: 'running',
  'waiting-approval': 'waiting for approval',
  error: 'error',
  elsewhere: 'running elsewhere',
  open: 'open elsewhere',
};

/** Relay's own state wins; otherwise another process holding the session shows as elsewhere. */
export function dotState(id: string, states?: RunState['states'], external?: ExternalSessions): string {
  const own = states?.[id]?.state;
  if (own && own !== 'idle') return own;
  if (external?.[id] === 'busy') return 'elsewhere';
  if (external?.[id] === 'idle') return 'open';
  return own ?? 'idle';
}

/** True while something is happening that the user would want to notice. */
export function isActive(dot: string): boolean {
  return dot === 'running' || dot === 'waiting-approval' || dot === 'elsewhere';
}
