import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ModelChoice } from '@relay/shared';
import { ModelPicker } from './ModelPicker';

const choices: ModelChoice[] = [
  { id: 'claude-opus-5', name: 'Opus 5', description: '', current: true },
  { id: 'claude-sonnet-4-5', name: 'Sonnet 4.5', description: '', current: false },
];

describe('ModelPicker', () => {
  it('names the model the session runs on, the way a person says it', () => {
    render(<ModelPicker model={{ id: 'claude-opus-5', source: 'last-run' }} models={[]} onSetModel={vi.fn()} />);
    expect(screen.getByText('Opus 5')).toBeInTheDocument();
  });

  it('says where that came from, so a choice is not confused with a reading', () => {
    const { rerender } = render(<ModelPicker model={{ id: 'claude-opus-5', source: 'last-run' }} models={[]} onSetModel={vi.fn()} />);
    expect(screen.getByTitle(/last request ran on/i)).toBeInTheDocument();
    rerender(<ModelPicker model={{ id: 'claude-opus-5', source: 'chosen' }} models={[]} onSetModel={vi.fn()} />);
    expect(screen.getByTitle(/set for this session/i)).toBeInTheDocument();
  });

  it('says a session that has never run has no model yet, rather than naming a default', () => {
    render(<ModelPicker model={null} models={[]} onSetModel={vi.fn()} />);
    expect(screen.getByText(/not set yet/i)).toBeInTheDocument();
  });

  it('offers the models this session can run on, with the one in use selected', () => {
    render(<ModelPicker model={{ id: 'claude-opus-5', source: 'chosen' }} models={choices} onSetModel={vi.fn()} />);
    expect(screen.getByLabelText('Model')).toHaveValue('claude-opus-5');
    expect(screen.getByRole('option', { name: 'Sonnet 4.5' })).toBeInTheDocument();
  });

  it('switches through the same handler the slash command uses', async () => {
    const onSetModel = vi.fn();
    render(<ModelPicker model={{ id: 'claude-opus-5', source: 'chosen' }} models={choices} onSetModel={onSetModel} />);
    await userEvent.selectOptions(screen.getByLabelText('Model'), 'claude-sonnet-4-5');
    expect(onSetModel).toHaveBeenCalledWith('claude-sonnet-4-5');
  });

  it('keeps showing a model the list does not offer, instead of silently picking another', () => {
    render(<ModelPicker model={{ id: 'claude-fable-5-1', source: 'chosen' }} models={choices} onSetModel={vi.fn()} />);
    expect(screen.getByLabelText('Model')).toHaveValue('');
    expect(screen.getByRole('option', { name: 'Fable 5.1' })).toBeInTheDocument();
  });
});
