import { createHash } from 'crypto';

export function createContentHash(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}
