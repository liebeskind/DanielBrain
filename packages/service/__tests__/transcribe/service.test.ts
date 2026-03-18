import { describe, it, expect, vi, beforeEach } from 'vitest';
import { formatAsSrt } from '../../src/transcribe/service.js';

describe('formatAsSrt', () => {
  it('formats segments as SRT subtitles', () => {
    const segments = [
      { start: 0, end: 2.5, text: 'Hello everyone.' },
      { start: 2.5, end: 5.1, text: 'Welcome to the meeting.' },
      { start: 5.1, end: 8.75, text: 'Let us begin.' },
    ];

    const srt = formatAsSrt(segments);

    expect(srt).toContain('1\n00:00:00,000 --> 00:00:02,500\nHello everyone.');
    expect(srt).toContain('2\n00:00:02,500 --> 00:00:05,100\nWelcome to the meeting.');
    expect(srt).toContain('3\n00:00:05,100 --> 00:00:08,750\nLet us begin.');
  });

  it('handles hours correctly', () => {
    const segments = [
      { start: 3661.5, end: 3665, text: 'Over an hour in.' },
    ];

    const srt = formatAsSrt(segments);
    expect(srt).toContain('01:01:01,500 --> 01:01:05,000');
  });

  it('handles empty segments', () => {
    expect(formatAsSrt([])).toBe('');
  });
});
