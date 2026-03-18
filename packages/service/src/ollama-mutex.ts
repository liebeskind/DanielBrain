export type OllamaPriority = 'background' | 'ingestion' | 'chat';

const LEVELS: Record<OllamaPriority, number> = { background: 0, ingestion: 1, chat: 2 };

const active: Record<OllamaPriority, number> = { background: 0, ingestion: 0, chat: 0 };

/**
 * Try to acquire the Ollama lock at a given priority.
 * Blocked by holders at the same or higher priority.
 * Lower-priority holders do NOT block (Ollama queues internally).
 */
export function acquireOllama(priority: OllamaPriority): boolean {
  const myLevel = LEVELS[priority];
  for (const p of Object.keys(active) as OllamaPriority[]) {
    if (active[p] > 0 && LEVELS[p] >= myLevel) return false;
  }
  active[priority]++;
  return true;
}

export function releaseOllama(priority: OllamaPriority): void {
  if (active[priority] > 0) active[priority]--;
}

/** Check without acquiring — used by callers that just want to peek. */
export function isOllamaBusyFor(priority: OllamaPriority): boolean {
  const myLevel = LEVELS[priority];
  for (const p of Object.keys(active) as OllamaPriority[]) {
    if (active[p] > 0 && LEVELS[p] >= myLevel) return true;
  }
  return false;
}

// For tests only
export function _resetForTest(): void {
  active.background = 0;
  active.ingestion = 0;
  active.chat = 0;
}
