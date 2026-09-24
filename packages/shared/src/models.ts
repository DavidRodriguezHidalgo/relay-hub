/** A model a session can be switched to. */
export interface ModelChoice {
  /** What to set, e.g. `opus[1m]` or a full model id. */
  id: string;
  name: string;
  description: string;
  /** True for the model the session is running on now. */
  current: boolean;
}
