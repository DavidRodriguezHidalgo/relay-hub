import { useEffect, useState } from 'react';

interface Project {
  name: string;
  root: string;
  sessions: number;
}

interface Props {
  listProjects: () => Promise<Project[]>;
  onCreate: (req: { project: string; branch: string; prompt: string }) => Promise<{ sessionId: string; cwd: string }>;
  onCreated: (sessionId: string) => void;
  onCancel: () => void;
}

/** Same rule as the engine's worktreePath (packages/engine/src/git/worktrees.ts); the renderer cannot import it. */
function previewPath(root: string, branch: string): string {
  const slash = root.lastIndexOf('/');
  return `${root.slice(0, slash)}/${root.slice(slash + 1)}-worktrees/${branch.replaceAll('/', '-')}`;
}

/** Starts a fresh Claude session in a new worktree of one of your repos. */
export function NewSessionForm({ listProjects, onCreate, onCreated, onCancel }: Props) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [project, setProject] = useState('');
  const [branch, setBranch] = useState('');
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void listProjects().then(setProjects, (e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [listProjects]);

  const ready = project !== '' && branch.trim() !== '' && prompt.trim() !== '' && !busy;
  const submit = async () => {
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      const created = await onCreate({ project, branch: branch.trim(), prompt: prompt.trim() });
      onCreated(created.sessionId);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <form
      className="new-session"
      aria-label="New session"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <label>
        Project
        <select aria-label="Project" value={project} onChange={(e) => setProject(e.target.value)}>
          <option value="">Choose a repo…</option>
          {projects.map((p) => (
            <option key={p.root} value={p.root}>
              {p.name} ({p.sessions})
            </option>
          ))}
        </select>
      </label>
      <label>
        Branch
        <input aria-label="Branch" placeholder="feat/my-change" value={branch} onChange={(e) => setBranch(e.target.value)} />
      </label>
      {project && branch.trim() && <p className="new-session__where">New worktree: {previewPath(project, branch.trim())}</p>}
      <label>
        First instruction
        <textarea aria-label="First instruction" rows={3} value={prompt} onChange={(e) => setPrompt(e.target.value)} />
      </label>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <div className="new-session__actions">
        <button type="submit" className="btn-primary" disabled={!ready}>
          {busy ? 'Creating…' : 'Create session'}
        </button>
        <button type="button" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      </div>
    </form>
  );
}
