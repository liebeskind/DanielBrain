import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/logger.js', () => ({
  createChildLogger: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
}));

import { formatAsSrt, applySpeakerNames } from '../../src/transcribe/service.js';

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

describe('applySpeakerNames', () => {
  it('replaces speaker labels in text and segments', () => {
    const text = '[SPEAKER_00] Hello there.\n[SPEAKER_01] Hi, how are you?';
    const segments = [
      { start: 0, end: 2, text: 'Hello there.', speaker: 'SPEAKER_00' },
      { start: 2, end: 4, text: 'Hi, how are you?', speaker: 'SPEAKER_01' },
    ];
    const speakerMap = { SPEAKER_00: 'Daniel', SPEAKER_01: 'Rob' };

    const result = applySpeakerNames(text, segments, speakerMap);

    expect(result.text).toBe('[Daniel] Hello there.\n[Rob] Hi, how are you?');
    expect(result.segments[0].speaker).toBe('Daniel');
    expect(result.segments[1].speaker).toBe('Rob');
  });

  it('leaves unmapped speakers unchanged', () => {
    const text = '[SPEAKER_00] Hello.\n[SPEAKER_01] Hi.';
    const segments = [
      { start: 0, end: 2, text: 'Hello.', speaker: 'SPEAKER_00' },
      { start: 2, end: 4, text: 'Hi.', speaker: 'SPEAKER_01' },
    ];
    const speakerMap = { SPEAKER_00: 'Daniel' };

    const result = applySpeakerNames(text, segments, speakerMap);

    expect(result.text).toBe('[Daniel] Hello.\n[SPEAKER_01] Hi.');
    expect(result.segments[0].speaker).toBe('Daniel');
    expect(result.segments[1].speaker).toBe('SPEAKER_01');
  });

  it('handles segments without speaker field', () => {
    const text = 'No speakers here.';
    const segments = [{ start: 0, end: 2, text: 'No speakers here.' }];
    const speakerMap = { SPEAKER_00: 'Daniel' };

    const result = applySpeakerNames(text, segments, speakerMap);

    expect(result.text).toBe('No speakers here.');
    expect(result.segments[0].speaker).toBeUndefined();
  });

  it('replaces all occurrences of the same speaker', () => {
    const text = '[SPEAKER_00] First line.\n[SPEAKER_01] Response.\n[SPEAKER_00] Second line.';
    const segments = [
      { start: 0, end: 2, text: 'First line.', speaker: 'SPEAKER_00' },
      { start: 2, end: 4, text: 'Response.', speaker: 'SPEAKER_01' },
      { start: 4, end: 6, text: 'Second line.', speaker: 'SPEAKER_00' },
    ];
    const speakerMap = { SPEAKER_00: 'Daniel', SPEAKER_01: 'Rob' };

    const result = applySpeakerNames(text, segments, speakerMap);

    expect(result.text).toBe('[Daniel] First line.\n[Rob] Response.\n[Daniel] Second line.');
    expect(result.segments[0].speaker).toBe('Daniel');
    expect(result.segments[2].speaker).toBe('Daniel');
  });
});
