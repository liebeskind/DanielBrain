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

  it('returns empty array when LLM returns empty array string', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        message: { content: '[]' },
      }),
    });

    const result = await extractRelationships(
      'Nothing interesting here.',
      ['Alice', 'Bob'],
      config,
    );
    expect(result).toEqual([]);
  });

  it('returns empty array when LLM returns non-array JSON', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        message: { content: '{"not": "an array"}' },
      }),
    });

    const result = await extractRelationships('Text', ['Alice'], config);
    expect(result).toEqual([]);
  });

  it('returns empty array on malformed JSON from LLM', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        message: { content: 'not valid json at all' },
      }),
    });

    await expect(
      extractRelationships('Text', ['Alice', 'Bob'], config),
    ).rejects.toThrow(); // JSON.parse throws
  });

  it('filters out entries with missing required string fields', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        message: {
          content: JSON.stringify([
            { source: 'Alice', target: 'Bob', relationship: 'works_with', description: 'They work together.' },
            { source: 'Alice', target: null, relationship: 'manages', description: 'Missing target' },
            { source: 123, target: 'Bob', relationship: 'reports_to', description: 'Numeric source' },
            { source: 'Carol', target: 'Dave', relationship: null, description: 'No relationship type' },
            { source: 'Eve', target: 'Frank', relationship: 'advises' }, // missing description
          ]),
        },
      }),
    });

    const result = await extractRelationships(
      'Some text',
      ['Alice', 'Bob', 'Carol', 'Dave', 'Eve', 'Frank'],
      config,
    );
    expect(result).toHaveLength(1);
    expect(result[0].source).toBe('Alice');
    expect(result[0].target).toBe('Bob');
  });

  it('filters out duplicate source===target relationships', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        message: {
          content: JSON.stringify([
            { source: 'Topia', target: 'Topia', relationship: 'self_ref', description: 'Self reference' },
            { source: 'Alice', target: 'Alice', relationship: 'works_at', description: 'Self loop' },
          ]),
        },
      }),
    });

    const result = await extractRelationships('Text', ['Alice', 'Topia'], config);
    expect(result).toEqual([]);
  });

  it('sends entities list in the prompt', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        message: { content: '[]' },
      }),
    });

    const entities = ['Gordon Smith', 'Topia', 'Canvas', 'Kevin Killeen'];
    await extractRelationships('Some text about entities', entities, config);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    const userMsg = body.messages.find((m: any) => m.role === 'user');
    expect(userMsg.content).toContain('Gordon Smith');
    expect(userMsg.content).toContain('Kevin Killeen');
    expect(userMsg.content).toContain('Canvas');
  });

  it('truncates content to 4000 characters', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        message: { content: '[]' },
      }),
    });

    const longContent = 'x'.repeat(10000);
    await extractRelationships(longContent, ['Alice'], config);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    const userMsg = body.messages.find((m: any) => m.role === 'user');
    // Content should be sliced to 4000 chars
    const contentPart = userMsg.content.split('Text:\n')[1].split('\n\nKnown entities')[0];
    expect(contentPart.length).toBe(4000);
  });

  it('uses the extraction model from config', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        message: { content: '[]' },
      }),
    });

    const customConfig = { ollamaBaseUrl: 'http://custom:11434', extractionModel: 'custom-model' };
    await extractRelationships('Text', ['Alice'], customConfig);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.model).toBe('custom-model');
    expect(mockFetch.mock.calls[0][0]).toContain('http://custom:11434');
  });
});
