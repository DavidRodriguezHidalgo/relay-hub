/**
 * An image a session produced, offered as evidence of what the work looks like.
 *
 * Relay does not take these itself. It reports images the agent wrote while working, which is
 * why the tool that produced one is part of the record: what you are looking at is the agent's
 * output, not a screenshot Relay went and captured.
 */
export interface Screenshot {
  /** Absolute path on disk. */
  path: string;
  name: string;
  /** When the session produced it. */
  at: string;
  /** The tool that wrote it, e.g. `Bash` or `Write`. */
  tool: string;
  /**
   * The image inlined, so the window can show it without reaching into the file system.
   * Null when the file was too large to inline; `path` still points at it.
   */
  dataUrl: string | null;
}
