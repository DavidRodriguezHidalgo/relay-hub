/** Something a session can be asked to run by name: a slash command, a skill or a plugin command. */
export interface Invocable {
  /** Without the leading slash, e.g. `review` or `superpowers:brainstorming`. */
  name: string;
  description: string;
  /** What the command expects after its name, when it says so. */
  argumentHint: string;
}
