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

vi.mock('../../src/logger.js', () => ({
  createChildLogger: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
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

  it('returns error immediately when initial acquireOllama returns false', async () => {
    const { acquireOllama } = await import('../../src/ollama-mutex.js');
    vi.mocked(acquireOllama).mockReturnValueOnce(false);

    const result = await handleDeepResearch(
      {
        question: 'Test busy',
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
    // Should not have made any fetch calls since mutex was not acquired
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('returns raw findings with error message when synthesis mutex fails', async () => {
    const { acquireOllama } = await import('../../src/ollama-mutex.js');
    // First call (planning): succeeds
    // Second call (synthesis): fails
    vi.mocked(acquireOllama)
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false);

    // Planning call succeeds
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        message: { content: JSON.stringify(['sub-q 1', 'sub-q 2']) },
      }),
    } as any);

    const result = await handleDeepResearch(
      {
        question: 'Test synthesis mutex fail',
        max_iterations: 3,
        include_community_context: false,
        synthesize: true,
      },
      mockPool as any,
      mockConfig,
    );

    expect(result.error).toContain('busy');
    expect(result.question).toBe('Test synthesis mutex fail');
    expect(result.sub_questions).toBeDefined();
    expect(result.execution_time_ms).toBeGreaterThanOrEqual(0);
    // Should NOT have answer since synthesis was skipped
    expect(result).not.toHaveProperty('answer');
  });

  it('throws when synthesis LLM returns invalid JSON', async () => {
    const { acquireOllama } = await import('../../src/ollama-mutex.js');
    // acquireOllama is called twice: once for planning, once for synthesis
    vi.mocked(acquireOllama).mockReturnValue(true);

    // Planning call: returns valid sub-questions
    global.fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          message: { content: JSON.stringify(['sub-q 1']) },
        }),
      } as any)
      // Synthesis call: returns invalid JSON
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          message: { content: 'This is not valid JSON at all!' },
        }),
      } as any);

    await expect(
      handleDeepResearch(
        {
          question: 'Test bad synthesis JSON',
          max_iterations: 3,
          include_community_context: false,
          synthesize: true,
        },
        mockPool as any,
        mockConfig,
      )
    ).rejects.toThrow();
  });

  it('throws when planning LLM returns malformed JSON', async () => {
    const { acquireOllama } = await import('../../src/ollama-mutex.js');
    vi.mocked(acquireOllama).mockReturnValue(true);

    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        message: { content: '{not valid json[[[' },
      }),
    } as any);

    await expect(
      handleDeepResearch(
        {
          question: 'Test bad planning JSON',
          max_iterations: 3,
          include_community_context: false,
          synthesize: false,
        },
        mockPool as any,
        mockConfig,
      )
    ).rejects.toThrow();
  });

  it('handles LLM returning "questions" key instead of "sub_questions"', async () => {
    const { acquireOllama } = await import('../../src/ollama-mutex.js');
    vi.mocked(acquireOllama).mockReturnValue(true);

    global.fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          message: {
            content: JSON.stringify({ questions: ['alt-format question 1', 'alt-format question 2'] }),
          },
        }),
      } as any)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          message: {
            content: JSON.stringify({
              answer: 'Answer from alt format.',
              confidence: 'low',
              gaps: [],
            }),
          },
        }),
      } as any);

    const result = await handleDeepResearch(
      {
        question: 'Test questions key format',
        max_iterations: 3,
        include_community_context: false,
        synthesize: true,
      },
      mockPool as any,
      mockConfig,
    );

    expect(result.sub_questions).toEqual(['alt-format question 1', 'alt-format question 2']);
  });

  it('clamps sub-questions to max_iterations', async () => {
    const { acquireOllama } = await import('../../src/ollama-mutex.js');
    vi.mocked(acquireOllama).mockReturnValue(true);

    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        message: {
          content: JSON.stringify(['q1', 'q2', 'q3', 'q4', 'q5']),
        },
      }),
    } as any);

    const result = await handleDeepResearch(
      {
        question: 'Test clamping',
        max_iterations: 2,
        include_community_context: false,
        synthesize: false,
      },
      mockPool as any,
      mockConfig,
    );

    // sub_questions in the result are SubQuestionResult[] (from executeSubQuestions)
    expect(Array.isArray(result.sub_questions)).toBe(true);
    // Should have at most 2 sub-question results
    expect((result.sub_questions as any[]).length).toBeLessThanOrEqual(2);
  });
});
