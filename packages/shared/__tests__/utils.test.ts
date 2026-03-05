import { describe, it, expect } from 'vitest';
import { createContentHash } from '../src/utils.js';

describe('createContentHash', () => {
  it('returns a 64-char hex string (sha256)', () => {
    const hash = createContentHash('hello world');
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('returns deterministic results', () => {
    expect(createContentHash('test')).toBe(createContentHash('test'));
  });

  it('returns different hashes for different inputs', () => {
    expect(createContentHash('a')).not.toBe(createContentHash('b'));
  });
});
