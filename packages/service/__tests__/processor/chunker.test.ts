import { describe, it, expect } from 'vitest';
import {
  chunkText, estimateTokens, needsChunking,
  splitIntoSegments, extractCodeBlocks, splitOnSpeakerTurns,
  splitOnHeadings, splitOnParagraphs, splitOnListBlocks, splitOnSentences,
} from '../../src/processor/chunker.js';
import type { SourceHint } from '../../src/processor/chunker.js';

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
      const lastWordsOfFirst = chunks[0].split(/\s+/).slice(-10).join(' ');
      // Use a flexible check: some words from end of chunk 0 appear at start of chunk 1
      const firstWordsOfSecond = chunks[1].split(/\s+/).slice(0, 20).join(' ');
      expect(firstWordsOfSecond).toContain(lastWordsOfFirst.split(' ').slice(-5).join(' '));
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

// --- Semantic chunking tests ---

describe('extractCodeBlocks', () => {
  it('extracts fenced code blocks', () => {
    const text = 'Before\n\n```javascript\nconst x = 1;\n```\n\nAfter';
    const { codeBlocks, stripped } = extractCodeBlocks(text);
    expect(codeBlocks).toHaveLength(1);
    expect(codeBlocks[0]).toContain('const x = 1;');
    expect(stripped).not.toContain('const x = 1;');
    expect(stripped).toContain('__CODE_BLOCK_0__');
  });

  it('handles multiple code blocks', () => {
    const text = '```a```\ntext\n```b```';
    const { codeBlocks, stripped } = extractCodeBlocks(text);
    expect(codeBlocks).toHaveLength(2);
    expect(stripped).toContain('__CODE_BLOCK_0__');
    expect(stripped).toContain('__CODE_BLOCK_1__');
  });

  it('returns empty when no code blocks', () => {
    const { codeBlocks, stripped } = extractCodeBlocks('No code here');
    expect(codeBlocks).toHaveLength(0);
    expect(stripped).toBe('No code here');
  });
});

describe('splitOnSpeakerTurns', () => {
  it('splits Fathom-style transcript', () => {
    const text = 'Daniel Liebeskind: Hello everyone.\nChris Psiaki: Hi Daniel.\nDaniel Liebeskind: Let us begin.';
    const parts = splitOnSpeakerTurns(text);
    expect(parts).toHaveLength(3);
    expect(parts[0]).toContain('Daniel Liebeskind: Hello');
    expect(parts[1]).toContain('Chris Psiaki: Hi');
    expect(parts[2]).toContain('Daniel Liebeskind: Let us');
  });

  it('handles timestamps before speaker names', () => {
    const text = '[00:01:23] Alice Smith: First point.\n[00:02:45] Bob Jones: Response.';
    const parts = splitOnSpeakerTurns(text);
    expect(parts).toHaveLength(2);
    expect(parts[0]).toContain('Alice Smith');
    expect(parts[1]).toContain('Bob Jones');
  });

  it('keeps multi-line speaker content together', () => {
    const text = 'Alice: First sentence.\nSecond sentence still from Alice.\nBob: New speaker.';
    const parts = splitOnSpeakerTurns(text);
    expect(parts).toHaveLength(2);
    expect(parts[0]).toContain('Second sentence');
    expect(parts[1]).toContain('Bob:');
  });
});

describe('splitOnHeadings', () => {
  it('splits on markdown headings', () => {
    const text = '## Introduction\n\nSome intro text.\n\n## Methods\n\nSome methods text.';
    const parts = splitOnHeadings(text);
    expect(parts).toHaveLength(2);
    expect(parts[0]).toContain('Introduction');
    expect(parts[1]).toContain('Methods');
  });

  it('handles different heading levels', () => {
    const text = '# Title\n\nText\n\n### Subsection\n\nMore text';
    const parts = splitOnHeadings(text);
    expect(parts).toHaveLength(2);
    expect(parts[0]).toContain('# Title');
    expect(parts[1]).toContain('### Subsection');
  });

  it('returns full text when no headings', () => {
    const text = 'Just regular text without any headings.';
    const parts = splitOnHeadings(text);
    expect(parts).toHaveLength(1);
    expect(parts[0]).toBe(text);
  });
});

describe('splitOnParagraphs', () => {
  it('splits on double newlines', () => {
    const text = 'Paragraph one.\n\nParagraph two.\n\nParagraph three.';
    const parts = splitOnParagraphs(text);
    expect(parts).toHaveLength(3);
  });

  it('handles triple+ newlines', () => {
    const text = 'A.\n\n\n\nB.';
    const parts = splitOnParagraphs(text);
    expect(parts).toHaveLength(2);
  });

  it('returns single segment for no double newlines', () => {
    const text = 'Single line of text.';
    const parts = splitOnParagraphs(text);
    expect(parts).toHaveLength(1);
  });
});

describe('splitOnListBlocks', () => {
  it('groups consecutive list items', () => {
    const text = 'Intro text.\n- Item 1\n- Item 2\n- Item 3\nConclusion.';
    const parts = splitOnListBlocks(text);
    expect(parts).toHaveLength(3);
    expect(parts[0]).toBe('Intro text.');
    expect(parts[1]).toContain('- Item 1');
    expect(parts[1]).toContain('- Item 3');
    expect(parts[2]).toBe('Conclusion.');
  });

  it('handles numbered lists', () => {
    const text = 'Header\n1. First\n2. Second';
    const parts = splitOnListBlocks(text);
    expect(parts).toHaveLength(2);
    expect(parts[1]).toContain('1. First');
  });

  it('handles asterisk lists', () => {
    const text = '* A\n* B';
    const parts = splitOnListBlocks(text);
    expect(parts).toHaveLength(1); // all list, stays together
    expect(parts[0]).toContain('* A');
  });

  it('passes through text without lists', () => {
    const text = 'No lists here.';
    const parts = splitOnListBlocks(text);
    expect(parts).toHaveLength(1);
    expect(parts[0]).toBe('No lists here.');
  });
});

describe('splitOnSentences', () => {
  it('splits on sentence-ending punctuation', () => {
    const text = 'First sentence. Second sentence! Third sentence?';
    const parts = splitOnSentences(text);
    expect(parts).toHaveLength(3);
    expect(parts[0]).toBe('First sentence.');
    expect(parts[1]).toBe('Second sentence!');
  });

  it('preserves newlines as boundaries', () => {
    const text = 'Line one\nLine two\nLine three';
    const parts = splitOnSentences(text);
    expect(parts).toHaveLength(3);
  });
});

describe('splitIntoSegments', () => {
  it('uses heading → paragraph → sentence hierarchy for general content', () => {
    const text = '## Section A\n\nParagraph one. Another sentence.\n\n## Section B\n\nParagraph two.';
    const segs = splitIntoSegments(text, 'general', 500);
    // Should split on headings since content fits
    expect(segs.length).toBe(2);
    expect(segs[0]).toContain('Section A');
    expect(segs[1]).toContain('Section B');
  });

  it('uses speaker turns for meeting content', () => {
    const text = 'Alice: Hello.\nBob: Hi there.\nAlice: How are you?';
    const segs = splitIntoSegments(text, 'meeting', 500);
    expect(segs.length).toBe(3);
    expect(segs[0]).toContain('Alice: Hello');
    expect(segs[1]).toContain('Bob: Hi');
  });

  it('preserves code blocks as atomic units', () => {
    const text = 'Before.\n\n```\nconst x = 1;\nconst y = 2;\n```\n\nAfter.';
    const segs = splitIntoSegments(text, 'general', 500);
    // Code block should appear intact in one segment
    const codeSegment = segs.find((s) => s.includes('const x = 1'));
    expect(codeSegment).toBeDefined();
    expect(codeSegment).toContain('const y = 2');
    expect(codeSegment).toContain('```');
  });

  it('recursively splits oversized heading sections on paragraphs', () => {
    // Create a heading section that exceeds maxTokens
    const bigParagraph1 = 'Word '.repeat(200); // ~267 tokens
    const bigParagraph2 = 'Word '.repeat(200);
    const text = `## Big Section\n\n${bigParagraph1}\n\n${bigParagraph2}`;
    const segs = splitIntoSegments(text, 'general', 300);
    // Should split the section into paragraph-level segments
    expect(segs.length).toBeGreaterThanOrEqual(2);
  });

  it('recursively splits oversized paragraphs on sentences', () => {
    const manySentences = Array.from({ length: 50 }, (_, i) =>
      `This is sentence ${i + 1} with enough words to fill up space.`
    ).join(' ');
    const segs = splitIntoSegments(manySentences, 'general', 100);
    expect(segs.length).toBeGreaterThan(1);
    // Each segment should end with sentence boundary
    for (const seg of segs.slice(0, -1)) {
      expect(seg.trimEnd().endsWith('.')).toBe(true);
    }
  });

  it('preserves list blocks as units', () => {
    const text = 'Intro paragraph.\n\n- Item A\n- Item B\n- Item C\n\nConclusion paragraph.';
    const segs = splitIntoSegments(text, 'general', 500);
    const listSeg = segs.find((s) => s.includes('- Item A'));
    expect(listSeg).toBeDefined();
    expect(listSeg).toContain('- Item B');
    expect(listSeg).toContain('- Item C');
  });

  it('handles mixed content: headings + paragraphs + code + lists', () => {
    const text = [
      '## Overview',
      '',
      'Introduction to the project.',
      '',
      '```python',
      'def hello():',
      '    print("hello")',
      '```',
      '',
      '## Features',
      '',
      'Key features:',
      '- Fast search',
      '- Entity graph',
      '- Community detection',
      '',
      'Conclusion paragraph.',
    ].join('\n');

    const segs = splitIntoSegments(text, 'general', 500);
    // Should have: Overview section (intro + code), Features section (text + list + conclusion)
    expect(segs.length).toBeGreaterThanOrEqual(2);
    // Code block should be intact
    const codeContaining = segs.find((s) => s.includes('def hello'));
    expect(codeContaining).toContain('print("hello")');
  });
});

describe('chunkText with sourceHint', () => {
  it('uses meeting splitting for meeting source', () => {
    // Create a long meeting transcript
    const turns = Array.from({ length: 100 }, (_, i) => {
      const speaker = i % 2 === 0 ? 'Alice' : 'Bob';
      return `${speaker}: This is turn ${i + 1} with some discussion content about important topics.`;
    });
    const text = turns.join('\n');

    const chunks = chunkText(text, 500, 50, 'meeting');
    expect(chunks.length).toBeGreaterThan(1);
    // Chunks should start with a speaker name (not mid-sentence)
    for (const chunk of chunks) {
      const firstLine = chunk.split('\n')[0];
      expect(firstLine).toMatch(/^(Alice|Bob):/);
    }
  });

  it('preserves code blocks in chunked output', () => {
    const codeBlock = '```\n' + 'line\n'.repeat(10) + '```';
    const filler = Array.from({ length: 600 }, (_, i) => `Sentence ${i + 1} here.`).join(' ');
    const text = filler.slice(0, 3000) + '\n\n' + codeBlock + '\n\n' + filler.slice(3000);

    const chunks = chunkText(text);
    const allContent = chunks.join(' ');
    expect(allContent).toContain('```');
    // Code block should not be split across chunks
    const chunksWithCode = chunks.filter((c) => c.includes('```'));
    for (const c of chunksWithCode) {
      const openCount = (c.match(/```/g) || []).length;
      expect(openCount % 2).toBe(0); // paired open/close
    }
  });
});
