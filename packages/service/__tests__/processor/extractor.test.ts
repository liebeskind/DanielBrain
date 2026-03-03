import { describe, it, expect, vi, beforeEach } from 'vitest';
import { extractMetadata } from '../../src/processor/extractor.js';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('extractMetadata', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('extracts all metadata fields from Ollama response', async () => {
    const ollamaResponse = {
      message: {
        content: JSON.stringify({
          thought_type: 'meeting_note',
          people: ['Alice', 'Bob'],
          topics: ['Q1 planning'],
          action_items: ['Draft proposal'],
          dates_mentioned: ['2026-04-01'],
          sentiment: 'positive',
          summary: 'Met with Alice and Bob about Q1',
        }),
      },
    };

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(ollamaResponse),
    });

    const result = await extractMetadata('Meeting with Alice and Bob about Q1 planning', {
      ollamaBaseUrl: 'http://localhost:11434',
      extractionModel: 'llama3.1:8b',
    });

    expect(result.thought_type).toBe('meeting_note');
    expect(result.people).toEqual(['Alice', 'Bob']);
    expect(result.topics).toEqual(['Q1 planning']);
    expect(result.action_items).toEqual(['Draft proposal']);
    expect(result.sentiment).toBe('positive');
    expect(result.summary).toBe('Met with Alice and Bob about Q1');
  });

  it('sends correct JSON schema for constrained decoding', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          message: {
            content: JSON.stringify({
              thought_type: null,
              people: [],
              topics: [],
              action_items: [],
              dates_mentioned: [],
              sentiment: null,
              summary: null,
            }),
          },
        }),
    });

    await extractMetadata('Some text', {
      ollamaBaseUrl: 'http://localhost:11434',
      extractionModel: 'llama3.1:8b',
    });

    const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(callBody.format).toBeDefined();
    expect(callBody.model).toBe('llama3.1:8b');
    expect(callBody.stream).toBe(false);
  });

  it('handles missing fields gracefully with defaults', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          message: {
            content: JSON.stringify({
              thought_type: 'idea',
              // Missing all other fields
            }),
          },
        }),
    });

    const result = await extractMetadata('Just an idea', {
      ollamaBaseUrl: 'http://localhost:11434',
      extractionModel: 'llama3.1:8b',
    });

    expect(result.thought_type).toBe('idea');
    expect(result.people).toEqual([]);
    expect(result.topics).toEqual([]);
    expect(result.action_items).toEqual([]);
  });

  it('throws on Ollama error', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: () => Promise.resolve('Model not found'),
    });

    await expect(
      extractMetadata('Test', {
        ollamaBaseUrl: 'http://localhost:11434',
        extractionModel: 'llama3.1:8b',
      })
    ).rejects.toThrow();
  });
});
