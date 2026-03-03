import crypto from 'node:crypto';

export function verifyAccessKey(
  provided: string | undefined,
  expected: string
): boolean {
  if (!provided || provided.length === 0) return false;
  if (provided.length !== expected.length) return false;

  return crypto.timingSafeEqual(
    Buffer.from(provided),
    Buffer.from(expected)
  );
}
