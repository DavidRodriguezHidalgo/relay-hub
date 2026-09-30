import type { ModelChoice, NewSessionModel } from '@relay/shared';

/**
 * The value the model source uses for "whatever is recommended right now".
 *
 * It belongs to the source's own vocabulary and is not the name of a model, so asking for it keeps
 * meaning the sensible everyday choice after the model behind it changes.
 */
const RECOMMENDED_ID = 'default';

/**
 * The option to use when the user has expressed no preference.
 *
 * The source marks one. If a future list stops using that marker, the first option is taken,
 * because these lists are ordered with the everyday choice first.
 */
export function recommendedModel(models: ModelChoice[]): ModelChoice | null {
  return models.find((m) => m.id === RECOMMENDED_ID) ?? models[0] ?? null;
}

/**
 * The model Relay asks for when it starts a session.
 *
 * With no choice stored, Relay asks for the recommended option rather than asking for nothing.
 * Asking for nothing is what made every new session inherit whatever a past `/model` command left
 * in the user's own settings file, which is a global that nothing in Relay could see or change.
 *
 * A stored choice is passed through untouched even when the list no longer offers it: silently
 * substituting a different model would be worse than a request that fails and says why.
 */
export function newSessionModel(chosen: string | null, models: ModelChoice[]): NewSessionModel {
  if (chosen) {
    return { id: chosen, resolvedModel: models.find((m) => m.id === chosen)?.resolvedModel ?? null, source: 'chosen' };
  }
  const recommended = recommendedModel(models);
  return recommended
    ? { id: recommended.id, resolvedModel: recommended.resolvedModel, source: 'recommended' }
    : { id: null, resolvedModel: null, source: 'unknown' };
}
