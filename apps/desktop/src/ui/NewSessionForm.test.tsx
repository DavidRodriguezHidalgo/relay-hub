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
    render(<NewSessionForm listProjects={async () => projects} onCreate={onCreate} onCreated={onCreated} onCancel={vi.fn()} />);
    const submit = await screen.findByRole('button', { name: 'Create session' });
    expect(submit).toBeDisabled();
    await userEvent.selectOptions(screen.getByLabelText('Project'), '/code/factorial');
    await userEvent.type(screen.getByLabelText('Branch'), 'feat/x');
    expect(submit).toBeDisabled();
    await userEvent.type(screen.getByLabelText('First instruction'), 'Add a CSV export');
    expect(submit).toBeEnabled();
    expect(screen.getByText(/factorial-worktrees\/feat-x/)).toBeInTheDocument(); // where it will go
    await userEvent.click(submit);
    expect(onCreate).toHaveBeenCalledWith({ project: '/code/factorial', branch: 'feat/x', prompt: 'Add a CSV export' });
    expect(onCreated).toHaveBeenCalledWith('n1');
  });

  it('shows why creating failed and stays open', async () => {
    const onCreate = vi.fn(async () => {
      throw new Error('The branch feat/x already exists; pick another name or use its worktree');
    });
    const onCreated = vi.fn();
    render(<NewSessionForm listProjects={async () => projects} onCreate={onCreate} onCreated={onCreated} onCancel={vi.fn()} />);
    await userEvent.selectOptions(await screen.findByLabelText('Project'), '/code/factorial');
    await userEvent.type(screen.getByLabelText('Branch'), 'feat/x');
    await userEvent.type(screen.getByLabelText('First instruction'), 'x');
    await userEvent.click(screen.getByRole('button', { name: 'Create session' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('already exists');
    expect(onCreated).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Create session' })).toBeEnabled();
  });
});
