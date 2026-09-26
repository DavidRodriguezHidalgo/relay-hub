/**
 * A piece of work you mean to do, and the session it became.
 *
 * The todo is the intention; once launched, the session holds the detail while the work is in
 * flight. `sessionId` is what joins the two, so the list doubles as a record of what is being
 * worked on and where.
 */
export interface Todo {
  id: string;
  title: string;
  /** Context for the work, sent as the session's first instruction when it is launched. */
  notes: string;
  /** Repo root the work belongs to; null until one is chosen. */
  project: string | null;
  /** Branch asked for at launch, so the work gets a worktree of its own. */
  branch: string | null;
  /** The session this became, once launched; null while it is still only an intention. */
  sessionId: string | null;
  done: boolean;
  /**
   * Where it sits in the list once it has been moved. Absent until then, and an absent one
   * falls back to when it was added, so a list nobody has reordered reads as it always did.
   */
  position?: number;
  createdAt: string;
  launchedAt: string | null;
}

/** What is needed to add a todo; the rest is filled in when it is launched. */
export interface TodoDraft {
  title: string;
  notes?: string;
  project?: string | null;
  branch?: string | null;
}

export type TodoPatch = Partial<Pick<Todo, 'title' | 'notes' | 'project' | 'branch' | 'done'>>;
