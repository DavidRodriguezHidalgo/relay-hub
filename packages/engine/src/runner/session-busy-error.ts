/** Someone else (a terminal) is writing this session's transcript; Relay must not drive it too. */
export class SessionBusyError extends Error {
  constructor(readonly sessionId: string) {
    super(`Session ${sessionId} is being written by another process`);
    this.name = 'SessionBusyError';
  }
}
