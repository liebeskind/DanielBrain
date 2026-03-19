import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleDeepResearch } from '../../src/mcp/tools/deep-research.js';

vi.mock('../../src/processor/embedder.js', () => ({
  embedQuery: vi.fn().mockResolvedValue(new Array(768).fill(0.1)),
  embed: vi.fn(),
  embedBatch: vi.fn(),
}));

vi.mock('../../src/mcp/tools/semantic-search.js', () => ({
  handleSemanticSearch: vi.fn().mockResolvedValue([
    {
      id: 't1',
      content: 'Partnership discussion with Stride',
      summary: 'Stride partnership terms',
      thought_type: 'meeting_note',
      people: ['Chris'],
      topics: ['Stride'],
      action_items: [],
      similarity: 0.82,
      source: 'fathom',
      created_at: new Date('2026-03-10'),
      parent_id: null,
      chunk_index: null,
      dates_mentioned: [],
    },
  ]),
}));

vi.mock('../../src/mcp/tools/global-search.js', () => ({
  handleGlobalSearch: vi.fn().mockResolvedValue({
    query: 'test',
    results: [
      { title: 'Partnerships', summary: 'Key strategic partnerships', similarity: 0.7 },
    ],
    total: 1,
  }),
}));

vi.mock('../../src/ollama-mutex.js', () => ({
  acquireOllama: vi.fn().mockReturnValue(true),
  releaseOllama: vi.fn(),
}));

const mockPool = {
  query: vi.fn(),
};

const mockConfig = {
  ollamaBaseUrl: 'http://localhost:11434',
  embeddingModel: 'nomic-embed-text',
  extractionModel: 'llama3.3:70b',
};

// Mock fetch for Ollama LLM calls
const originalFetch = global.fetch;

describe('handleDeepResearch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Mock fetch for planning + synthesis calls
    global.fetch = vi.fn()
      // Planning call
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          message: {
            content: JSON.stringify([
              'Stride partnership history',
              'K12 Zone product collaboration',
            ]),
          },
        }),
      } as any)
      // Synthesis call
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          message: {
            content: JSON.stringify({
              answer: 'Based on meeting notes, Stride is a key strategic partner for the K12 Zone product.',
              confidence: 'medium',
              gaps: ['No information about financial terms'],
            }),
          },
        }),
      } as any);
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  it('plans sub-questions, executes searches, and synthesizes', async () => {
    const result = await handleDeepResearch(
      {
        question: 'What is the full picture of our relationship with Stride?',
        max_iterations: 3,
        include_community_context: true,
        synthesize: true,
      },
      mockPool as any,
      mockConfig,
    );

    expect(result).toMatchObject({
      question: 'What is the full picture of our relationship with Stride?',
      answer: expect.stringContaining('Stride'),
      confidence: 'medium',
      gaps: expect.arrayContaining([expect.stringContaining('financial')]),
      sub_questions: expect.arrayContaining(['Stride partnership history']),
    });
    expect(result.execution_time_ms).toBeGreaterThanOrEqual(0);
    expect(result.sources).toBeDefined();
  });

  it('returns raw findings when synthesize=false', async () => {
    // Only planning call needed (no synthesis)
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        message: {
          content: JSON.stringify(['sub-question 1', 'sub-question 2']),
        },
      }),
    } as any);

    const result = await handleDeepResearch(
      {
        question: 'Test question',
        max_iterations: 2,
        include_community_context: false,
        synthesize: false,
      },
      mockPool as any,
      mockConfig,
    );

    expect(result).toHaveProperty('sub_questions');
    expect(result).not.toHaveProperty('answer');
    expect(result.execution_time_ms).toBeGreaterThanOrEqual(0);

    // Verify it's an array of sub-question results (not strings)
    expect(Array.isArray(result.sub_questions)).toBe(true);
    if (Array.isArray(result.sub_questions) && result.sub_questions.length > 0) {
      expect(result.sub_questions[0]).toHaveProperty('question');
      expect(result.sub_questions[0]).toHaveProperty('thoughts');
    }
  });

  it('returns error when LLM is busy', async () => {
    const { acquireOllama } = await import('../../src/ollama-mutex.js');
    vi.mocked(acquireOllama).mockReturnValueOnce(false);

    const result = await handleDeepResearch(
      {
        question: 'Test',
        max_iterations: 3,
        include_community_context: true,
        synthesize: true,
      },
      mockPool as any,
      mockConfig,
    );

    expect(result).toMatchObject({
      error: expect.stringContaining('busy'),
    });
  });

  it('handles LLM returning object format for sub-questions', async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          message: {
            content: JSON.stringify({ sub_questions: ['question A', 'question B'] }),
          },
        }),
      } as any)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          message: {
            content: JSON.stringify({
              answer: 'Synthesized answer.',
              confidence: 'high',
              gaps: [],
            }),
          },
        }),
      } as any);

    const result = await handleDeepResearch(
      {
        question: 'Test with object format',
        max_iterations: 3,
        include_community_context: true,
        synthesize: true,
      },
      mockPool as any,
      mockConfig,
    );

    expect(result.sub_questions).toEqual(['question A', 'question B']);
  });

  it('handles planning call failure', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 500,
    } as any);

    await expect(
      handleDeepResearch(
        {
          question: 'Test',
          max_iterations: 3,
          include_community_context: true,
          synthesize: true,
        },
        mockPool as any,
        mockConfig,
      )
    ).rejects.toThrow('Ollama planning call failed');
  });
});
