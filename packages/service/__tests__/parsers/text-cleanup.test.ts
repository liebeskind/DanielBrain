import { describe, it, expect } from 'vitest';
import { cleanupText } from '../../src/parsers/text-cleanup.js';

describe('cleanupText', () => {
  it('dehyphenates split words', () => {
    expect(cleanupText('informa-\ntion')).toBe('information');
  });

  it('preserves intentional hyphens (no newline)', () => {
    expect(cleanupText('well-known')).toBe('well-known');
  });

  it('collapses triple+ newlines to double', () => {
    expect(cleanupText('hello\n\n\n\nworld')).toBe('hello\n\nworld');
  });

  it('collapses runs of spaces', () => {
    expect(cleanupText('hello    world')).toBe('hello world');
  });

  it('trims trailing whitespace per line', () => {
    expect(cleanupText('hello   \nworld   ')).toBe('hello\nworld');
  });

  it('handles mixed dirty PDF output', () => {
    const dirty = '  This is a docu-\nment about impor-\ntant things.  \n\n\n\n\nIt has    extra   spaces.\n\n\nAnd too many   newlines.  ';
    const clean = cleanupText(dirty);
    expect(clean).toBe('This is a document about important things.\n\nIt has extra spaces.\n\nAnd too many newlines.');
  });

  it('returns empty string for whitespace-only input', () => {
    expect(cleanupText('   \n\n   ')).toBe('');
  });
});
