/** Another process is driving this session; Relay must not drive it too. */
export class SessionBusyError extends Error {
  constructor(
    readonly sessionId: string,
    readonly holderPids: number[] = [],
  ) {
    super(
      holderPids.length > 0
        ? `Session ${sessionId} is open in another Claude process (pid ${holderPids.join(', ')}). Close it there, or take it over.`
        : `Session ${sessionId} is being written by another process. Close it there, or take it over.`,
    );
    this.name = 'SessionBusyError';
  }
}
