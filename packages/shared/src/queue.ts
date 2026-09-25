import type { MessageOrigin } from './runner';

/**
 * What became of one instruction.
 *
 * `pending` means sent to the session and not yet answered — it may be running or waiting behind
 * the current turn, which is the agent's business, not something Relay can see. `dropped` means
 * the run ended before it was answered: that instruction was lost, and saying so is the point.
 */
export type QueuedState = 'pending' | 'done' | 'dropped';

export interface QueuedMessage {
  id: string;
  text: string;
  origin: MessageOrigin;
  at: string;
  state: QueuedState;
}
