import { modelLabel, type ModelChoice, type ModelInEffect } from '@relay/shared';

interface Props {
  /** The model in effect, or null when the session has never run and nothing was chosen. */
  model: ModelInEffect | null;
  /** What this session can be switched to; empty until the session has been asked. */
  models: ModelChoice[];
  onSetModel: (id: string) => void;
}

/**
 * Which model this session runs on, and a way to change it.
 *
 * Reference, not a headline, so it reads as plain text until used. The choices are the ones
 * `/model` offers, driven through the same handler, rather than a second way of switching.
 * A session that has never run says so instead of naming whatever the default would be.
 */
export function ModelPicker({ model, models, onSetModel }: Props) {
  if (!model && models.length === 0) {
    return <span className="model model--unknown">model not set yet</span>;
  }
  const current = model?.id ?? '';
  const title = model
    ? model.source === 'chosen'
      ? `Set for this session: ${model.id}`
      : `What its last request ran on: ${model.id}`
    : 'This session has not run yet, so no model is in effect.';
  if (models.length === 0) {
    return (
      <span className="model" title={title}>
        {modelLabel(current)}
      </span>
    );
  }
  return (
    <select
      className="model model--pick"
      aria-label="Model"
      title={title}
      value={models.some((m) => m.id === current) ? current : ''}
      onChange={(e) => e.target.value && onSetModel(e.target.value)}
    >
      {!models.some((m) => m.id === current) && (
        <option value="">{model ? modelLabel(current) : 'model not set yet'}</option>
      )}
      {models.map((m) => (
        <option key={m.id} value={m.id}>
          {m.name}
        </option>
      ))}
    </select>
  );
}
