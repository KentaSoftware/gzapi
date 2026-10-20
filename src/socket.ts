/**
 * Compatibility adapter for REST call sites that still describe realtime events.
 * Socket.IO is intentionally absent from this deployment, so these events are
 * ignored rather than attempting to access an uninitialized server.
 */
export function emitSocket (_type: string, _params: object): void {}
