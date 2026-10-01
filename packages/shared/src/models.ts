import { modelLabel } from './model-in-effect';

/**
 * The value the model source uses for "whatever is recommended right now".
 *
 * It belongs to the source's own vocabulary and names no model of its own, which is why a row
 * carrying it cannot stand in for the model it resolves to.
 */
export const RECOMMENDED_MODEL_ID = 'default';

/** A model a session can be switched to. */
export interface ModelChoice {
  /** What to set, e.g. `opus[1m]` or a full model id. */
  id: string;
  name: string;
  description: string;
  /**
   * What this choice actually runs as, or null when the source did not say.
   *
   * The recommended option names no model of its own, so this is the only way to say what a
   * session will really come up on before it is started.
   */
  resolvedModel: string | null;
  /** True for the model the session is running on now. */
  current: boolean;
}

/** What a new session will run on, and why it is that. */
export interface NewSessionModel {
  /** What Relay asks for, or null when it has no list and can only ask for nothing. */
  id: string | null;
  /** What that actually runs as, when the source said so. */
  resolvedModel: string | null;
  /**
   * `recommended` is the option the source marks as such. `first-listed` is the fallback taken
   * when nothing is marked, kept apart from it so nothing claims the source recommended a model
   * it never did.
   */
  source: 'chosen' | 'recommended' | 'first-listed' | 'unknown';
}

/** Settings the user controls, kept by Relay rather than by any one session. */
export interface RelaySettings {
  allowAllActions: boolean;
  /**
   * The model saved in the file below, if any. Relay does not use it — it is reported so the app
   * can say plainly which file it is leaving alone.
   */
  claudeDefaultModel: string | null;
  claudeSettingsPath: string;
}

const WHY: Record<Exclude<NewSessionModel['source'], 'unknown'>, string> = {
  chosen: 'your choice',
  recommended: 'the recommended default',
  'first-listed': 'the first model offered',
};

/**
 * What a new session will come up on, said plainly enough to act on before starting one.
 *
 * Lives here because the create form and Settings both have to say it, and the case that matters
 * most — a stored choice the list no longer offers — is exactly the one a component is likely to
 * render as nothing at all.
 */
export function newSessionModelSentence(model: NewSessionModel | null): string {
  if (!model) return 'Looking up what new sessions will run on…';
  if (model.source === 'unknown' || !model.id) {
    return 'The list of models could not be read, so Claude Code will choose and Relay cannot say what that will be.';
  }
  if (!model.resolvedModel) {
    return `${modelLabel(model.id)} is no longer in the list of models offered, so starting a session will fail until you pick another.`;
  }
  return `New sessions run on ${modelLabel(model.resolvedModel)} — ${WHY[model.source]}.`;
}

/** Whether that sentence reports a problem to act on rather than a plain statement of fact. */
export function newSessionModelIsTrouble(model: NewSessionModel | null): boolean {
  return model !== null && (model.source === 'unknown' || !model.id || !model.resolvedModel);
}
