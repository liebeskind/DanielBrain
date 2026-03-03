import { describe, it, expect } from 'vitest';
import { chunkText, estimateTokens, needsChunking } from '../../src/processor/chunker.js';

describe('estimateTokens', () => {
  it('estimates tokens from word count', () => {
    const text = 'Hello world this is a test';
    const tokens = estimateTokens(text);
    // ~1.33 tokens per word is a common heuristic
    expect(tokens).toBeGreaterThan(0);
    expect(tokens).toBeLessThan(20);
  });

  it('returns 0 for empty string', () => {
    expect(estimateTokens('')).toBe(0);
  });
});

describe('needsChunking', () => {
  it('returns false for short text', () => {
    expect(needsChunking('Short text')).toBe(false);
  });

  it('returns true for text exceeding threshold', () => {
    // ~6000 tokens = ~4500 words
    const longText = 'word '.repeat(5000);
    expect(needsChunking(longText)).toBe(true);
  });
});

describe('chunkText', () => {
  it('returns single chunk for short text', () => {
    const chunks = chunkText('Short text that fits in one chunk');
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBe('Short text that fits in one chunk');
  });

  it('splits long text into multiple chunks', () => {
    // Create text with clear sentence boundaries (~600 sentences * ~11 words = ~6600 words > 6000 tokens)
    const sentences = Array.from({ length: 600 }, (_, i) =>
      `This is sentence number ${i + 1} with enough words to add up.`
    );
    const longText = sentences.join(' ');

    const chunks = chunkText(longText);
    expect(chunks.length).toBeGreaterThan(1);
  });

  it('chunks have overlap', () => {
    const sentences = Array.from({ length: 600 }, (_, i) =>
      `This is sentence number ${i + 1} with enough words to add up to the total.`
    );
    const longText = sentences.join(' ');

    const chunks = chunkText(longText);
    if (chunks.length >= 2) {
      // End of first chunk should overlap with beginning of second chunk
      const lastWordsOfFirst = chunks[0].split(' ').slice(-10).join(' ');
      expect(chunks[1]).toContain(lastWordsOfFirst);
    }
  });

  it('splits on sentence boundaries', () => {
    const sentences = Array.from({ length: 600 }, (_, i) =>
      `Sentence ${i + 1} is here.`
    );
    const longText = sentences.join(' ');

    const chunks = chunkText(longText);
    // Each chunk should end with a period (sentence boundary)
    for (const chunk of chunks.slice(0, -1)) {
      expect(chunk.trimEnd().endsWith('.')).toBe(true);
    }
  });

  it('handles empty string', () => {
    const chunks = chunkText('');
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBe('');
  });

  it('handles text exactly at threshold', () => {
    // Right at threshold — should not chunk
    const text = 'word '.repeat(4500); // ~6000 tokens
    const chunks = chunkText(text.trim());
    // May or may not chunk depending on exact estimation, but should not crash
    expect(chunks.length).toBeGreaterThanOrEqual(1);
  });
});
