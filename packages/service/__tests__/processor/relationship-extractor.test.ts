import { describe, it, expect, vi, beforeEach } from 'vitest';
import { extractRelationships, RELATIONSHIP_EXTRACTION_PROMPT } from '../../src/processor/relationship-extractor.js';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const config = {
  ollamaBaseUrl: 'http://localhost:11434',
  extractionModel: 'llama3.3:70b',
};

describe('extractRelationships', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('extracts relationships from LLM response', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        message: {
          content: JSON.stringify([
            { source: 'Gordon Smith', target: 'Topia', relationship: 'works_at', description: 'Gordon works at Topia.' },
          ]),
        },
      }),
    });

    const result = await extractRelationships(
      'Gordon Smith leads Topia engineering.',
      ['Gordon Smith', 'Topia'],
      config,
    );

    expect(result).toHaveLength(1);
    expect(result[0].source).toBe('Gordon Smith');
    expect(result[0].relationship).toBe('works_at');
  });

  it('returns empty array when no relationships found', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        message: { content: '[]' },
      }),
    });

    const result = await extractRelationships('Some text', ['Alice', 'Bob'], config);
    expect(result).toEqual([]);
  });

  it('filters out self-referencing relationships', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        message: {
          content: JSON.stringify([
            { source: 'Alice', target: 'Alice', relationship: 'self', description: 'Self ref' },
            { source: 'Alice', target: 'Bob', relationship: 'works_with', description: 'Valid' },
          ]),
        },
      }),
    });

    const result = await extractRelationships('Text', ['Alice', 'Bob'], config);
    expect(result).toHaveLength(1);
    expect(result[0].target).toBe('Bob');
  });

  it('includes timeout signal in fetch call', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        message: { content: '[]' },
      }),
    });

    await extractRelationships('Text', ['Alice', 'Bob'], config);

    expect(mockFetch.mock.calls[0][1].signal).toBeDefined();
  });

  it('uses relationship extraction prompt', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        message: { content: '[]' },
      }),
    });

    await extractRelationships('Text', ['Alice', 'Bob'], config);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    const systemMsg = body.messages.find((m: any) => m.role === 'system');
    expect(systemMsg.content).toContain('explicit');
    expect(systemMsg.content).toContain('co-occurrence');
  });

  it('throws on Ollama error', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: () => Promise.resolve('Model error'),
    });

    await expect(
      extractRelationships('Text', ['Alice', 'Bob'], config),
    ).rejects.toThrow();
  });

  it('exports the prompt for inspection', () => {
    expect(RELATIONSHIP_EXTRACTION_PROMPT).toContain('explicit');
  });
});
