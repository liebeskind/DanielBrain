/**
 * Sanitize error messages for client responses.
 * In development, returns the actual error message.
 * In production, returns a generic message to avoid leaking internals.
 */
export function sanitizeError(err: unknown, genericMessage = 'Internal error'): string {
  if (process.env.NODE_ENV === 'development') {
    return (err as Error)?.message || genericMessage;
  }
  return genericMessage;
}
