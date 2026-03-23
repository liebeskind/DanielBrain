import { describe, it, expect, vi, afterEach } from 'vitest';
import { sanitizeError } from '../src/errors.js';

describe('sanitizeError', () => {
  const originalEnv = process.env.NODE_ENV;

  afterEach(() => {
    process.env.NODE_ENV = originalEnv;
  });

  it('returns generic message in production', () => {
    process.env.NODE_ENV = 'production';
    const err = new Error('SELECT * FROM secrets WHERE leaked = true');
    expect(sanitizeError(err)).toBe('Internal error');
  });

  it('returns custom generic message in production', () => {
    process.env.NODE_ENV = 'production';
    expect(sanitizeError(new Error('bad'), 'Something went wrong')).toBe('Something went wrong');
  });

  it('returns actual error message in development', () => {
    process.env.NODE_ENV = 'development';
    const err = new Error('detailed debug info');
    expect(sanitizeError(err)).toBe('detailed debug info');
  });

  it('handles non-Error objects gracefully', () => {
    process.env.NODE_ENV = 'production';
    expect(sanitizeError('string error')).toBe('Internal error');
    expect(sanitizeError(null)).toBe('Internal error');
    expect(sanitizeError(undefined)).toBe('Internal error');
  });

  it('returns generic message in non-development environments', () => {
    process.env.NODE_ENV = 'test';
    expect(sanitizeError(new Error('test detail'))).toBe('Internal error');
  });
});
