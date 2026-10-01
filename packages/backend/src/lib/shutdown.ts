// Shared process lifecycle: already-sent requests finish; subsequent paid work waits for restart.
export const shutdownSignal = new AbortController();
