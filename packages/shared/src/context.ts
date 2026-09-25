/**
 * How full a session's context was the last time it asked the model something.
 *
 * This is always an approximation, and the window says so. The token counts are exact — they
 * are what the model reported — but the size of the window is inferred from the model's name,
 * and a session that has since been compacted will read fuller than it now is.
 */
export interface ContextUse {
  /** Tokens the most recent request carried: fresh input, cache writes and cache reads. */
  tokens: number;
  /** The context window assumed for this model. */
  limit: number;
  /** Rounded, 0–100. */
  percent: number;
  /** The model that answered, as the transcript recorded it. */
  model: string | null;
  /** When that request was made. */
  at: string | null;
}
