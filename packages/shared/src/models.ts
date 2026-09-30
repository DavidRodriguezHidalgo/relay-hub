/** A model a session can be switched to. */
export interface ModelChoice {
  /** What to set, e.g. `opus[1m]` or a full model id. */
  id: string;
  name: string;
  description: string;
  /**
   * What this choice actually runs as.
   *
   * The recommended option names no model of its own, so this is the only way to say what a
   * session will really come up on before it is started.
   */
  resolvedModel: string;
  /** True for the model the session is running on now. */
  current: boolean;
}

/** What a new session will run on, and why it is that. */
export interface NewSessionModel {
  /** What Relay asks for, or null when it has no list and can only ask for nothing. */
  id: string | null;
  /** What that actually runs as, when the source said so. */
  resolvedModel: string | null;
  source: 'chosen' | 'recommended' | 'unknown';
}
