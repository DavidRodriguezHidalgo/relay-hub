import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NewSessionForm } from './NewSessionForm';

const projects = [
  { name: 'factorial', root: '/code/factorial', sessions: 3 },
  { name: 'factorial-agent', root: '/code/factorial-agent', sessions: 5 },
];

describe('NewSessionForm', () => {
  it('needs a project, a branch and an instruction, then creates the session', async () => {
    const onCreate = vi.fn(async () => ({ sessionId: 'n1', cwd: '/code/factorial-worktrees/feat-x' }));
    const onCreated = vi.fn();
    render(<NewSessionForm listProjects={async () => projects} model={null} onCreate={onCreate} onCreated={onCreated} onCancel={vi.fn()} />);
    const submit = await screen.findByRole('button', { name: 'Create session' });
    expect(submit).toBeDisabled();
    await userEvent.selectOptions(screen.getByLabelText('Project'), '/code/factorial');
    await userEvent.type(screen.getByLabelText('Branch'), 'feat/x');
    expect(submit).toBeDisabled();
    await userEvent.type(screen.getByLabelText('First instruction'), 'Add a CSV export');
    expect(submit).toBeEnabled();
    expect(screen.getByText(/factorial-worktrees\/feat-x/)).toBeInTheDocument(); // where it will go
    await userEvent.click(submit);
    expect(onCreate).toHaveBeenCalledWith({ project: '/code/factorial', branch: 'feat/x', prompt: 'Add a CSV export', inPlace: false });
    expect(onCreated).toHaveBeenCalledWith('n1');
  });

  it('shows why creating failed and stays open', async () => {
    const onCreate = vi.fn(async () => {
      throw new Error('The branch feat/x already exists; pick another name or use its worktree');
    });
    const onCreated = vi.fn();
    render(<NewSessionForm listProjects={async () => projects} model={null} onCreate={onCreate} onCreated={onCreated} onCancel={vi.fn()} />);
    await userEvent.selectOptions(await screen.findByLabelText('Project'), '/code/factorial');
    await userEvent.type(screen.getByLabelText('Branch'), 'feat/x');
    await userEvent.type(screen.getByLabelText('First instruction'), 'x');
    await userEvent.click(screen.getByRole('button', { name: 'Create session' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('already exists');
    expect(onCreated).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Create session' })).toBeEnabled();
  });
});

describe('NewSessionForm and the model it will use', () => {
  const projects = async () => [{ name: 'relay', root: '/code/relay', sessions: 2 }];
  const form = (model: Parameters<typeof NewSessionForm>[0]['model']) =>
    render(
      <NewSessionForm listProjects={projects} model={model} onCreate={vi.fn()} onCreated={vi.fn()} onCancel={vi.fn()} />,
    );

  it('says what the session will run on before it is created', async () => {
    form({ id: 'default', resolvedModel: 'claude-opus-5[1m]', source: 'recommended' });
    expect(await screen.findByText(/New sessions run on Opus 5 \[1m\]/)).toBeInTheDocument();
  });

  it('warns when the chosen model is no longer offered, instead of showing nothing at all', () => {
    form({ id: 'claude-sonnet-4-5', resolvedModel: null, source: 'chosen' });
    // creation would fail on this, so it has to be said where the session is created
    expect(screen.getByText(/no longer in the list of models offered/)).toBeInTheDocument();
  });

  it('says so when the model list could not be read, rather than staying quiet', () => {
    form({ id: null, resolvedModel: null, source: 'unknown' });
    expect(screen.getByText(/could not be read/)).toBeInTheDocument();
  });

  it('says nothing about the model rather than guessing, when it is not known yet', () => {
    form(null);
    expect(screen.queryByText(/run on/)).not.toBeInTheDocument();
  });
});

describe('NewSessionForm: worktree or the checkout itself', () => {
  const projects = async () => [{ name: 'relay', root: '/code/relay', sessions: 2 }];
  const form = (onCreate = vi.fn()) =>
    render(
      <NewSessionForm listProjects={projects} model={null} onCreate={onCreate} onCreated={vi.fn()} onCancel={vi.fn()} />,
    );

  it('defaults to a fresh worktree, which is what keeps sessions out of each other’s way', async () => {
    form();
    expect(await screen.findByRole('radio', { name: /new worktree/i })).toBeChecked();
    expect(screen.getByRole('radio', { name: /this checkout/i })).not.toBeChecked();
  });

  it('states the risk where the choice is made, not somewhere else', async () => {
    form();
    await userEvent.click(await screen.findByRole('radio', { name: /this checkout/i }));
    expect(screen.getByText(/same files|same directory/i)).toBeInTheDocument();
  });

  it('stops asking for a branch once the checkout is chosen, since none is made', async () => {
    form();
    await userEvent.click(await screen.findByRole('radio', { name: /this checkout/i }));
    expect(screen.queryByLabelText('Branch')).not.toBeInTheDocument();
  });

  it('creates in place, with no branch', async () => {
    const onCreate = vi.fn(async () => ({ sessionId: 'n1', cwd: '/code/relay' }));
    form(onCreate);
    await userEvent.selectOptions(await screen.findByLabelText('Project'), '/code/relay');
    await userEvent.click(screen.getByRole('radio', { name: /this checkout/i }));
    await userEvent.type(screen.getByLabelText('First instruction'), 'try it');
    await userEvent.click(screen.getByRole('button', { name: 'Create session' }));
    expect(onCreate).toHaveBeenCalledWith({ project: '/code/relay', branch: '', prompt: 'try it', inPlace: true });
  });

  it('still creates a worktree on the default path', async () => {
    const onCreate = vi.fn(async () => ({ sessionId: 'n1', cwd: '/code/relay-worktrees/feat-x' }));
    form(onCreate);
    await userEvent.selectOptions(await screen.findByLabelText('Project'), '/code/relay');
    await userEvent.type(screen.getByLabelText('Branch'), 'feat/x');
    await userEvent.type(screen.getByLabelText('First instruction'), 'go');
    await userEvent.click(screen.getByRole('button', { name: 'Create session' }));
    expect(onCreate).toHaveBeenCalledWith({ project: '/code/relay', branch: 'feat/x', prompt: 'go', inPlace: false });
  });
});
