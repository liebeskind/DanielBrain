/**
 * In-memory registry of poller health status.
 * Each poller records its last success/error for the /health endpoint.
 */

interface PollerState {
  lastSuccess: string | null;
  lastError: string | null;
  lastErrorMessage: string | null;
}

const pollers = new Map<string, PollerState>();

export function recordPollerSuccess(name: string): void {
  const state = pollers.get(name) || { lastSuccess: null, lastError: null, lastErrorMessage: null };
  state.lastSuccess = new Date().toISOString();
  pollers.set(name, state);
}

export function recordPollerError(name: string, error: string): void {
  const state = pollers.get(name) || { lastSuccess: null, lastError: null, lastErrorMessage: null };
  state.lastError = new Date().toISOString();
  state.lastErrorMessage = error;
  pollers.set(name, state);
}

export function getPollerStatuses(): Record<string, PollerState> {
  const result: Record<string, PollerState> = {};
  for (const [name, state] of pollers) {
    result[name] = { ...state };
  }
  return result;
}

/** Reset all pollers — for testing only. */
export function _resetForTest(): void {
  pollers.clear();
}
