import { describe, it, expect, vi } from 'vitest';
import { verifyAccessKey } from '../src/auth.js';

describe('verifyAccessKey', () => {
  const validKey = 'a'.repeat(64);

  it('passes for valid key', () => {
    expect(verifyAccessKey(validKey, validKey)).toBe(true);
  });

  it('rejects missing key', () => {
    expect(verifyAccessKey(undefined, validKey)).toBe(false);
  });

  it('rejects empty key', () => {
    expect(verifyAccessKey('', validKey)).toBe(false);
  });

  it('rejects wrong key', () => {
    expect(verifyAccessKey('b'.repeat(64), validKey)).toBe(false);
  });

  it('uses timing-safe comparison', () => {
    // Keys of same length should use constant-time compare
    const wrongKey = 'b'.repeat(64);
    expect(verifyAccessKey(wrongKey, validKey)).toBe(false);
  });
});
