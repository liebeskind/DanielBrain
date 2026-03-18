import { describe, it, expect, vi, beforeEach } from 'vitest';
import { extractMetadata, GLEANING_SYSTEM_PROMPT, GLEANING_SCHEMA } from '../../src/processor/extractor.js';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const baseConfig = {
  ollamaBaseUrl: 'http://localhost:11434',
  extractionModel: 'llama3.3:70b',
};

function mockOllamaResponse(content: Record<string, unknown>) {
  return {
    ok: true,
    json: () => Promise.resolve({ message: { content: JSON.stringify(content) } }),
  };
}

const fullExtraction = {
  thought_type: 'meeting_note',
  people: ['Alice', 'Bob'],
  topics: ['Q1 planning'],
  action_items: ['Draft proposal'],
  dates_mentioned: ['2026-04-01'],
  sentiment: 'positive',
  summary: 'Met with Alice and Bob about Q1',
  companies: ['Acme Corp'],
  products: ['Widget Pro'],
  projects: ['Project Alpha'],
  department: 'engineering',
  confidentiality: 'internal',
  themes: ['product_strategy'],
  key_decisions: ['Launch beta by March 15'],
  key_insights: ['LTI 1.3 requires SSO passthrough'],
  meeting_participants: ['Alice', 'Bob'],
  action_items_structured: [{ action: 'Draft proposal', assignee: 'Alice', deadline: null, status: 'open' }],
};

const emptyGleaning = {
  additional_people: [],
  additional_companies: [],
  additional_products: [],
  additional_projects: [],
  additional_action_items: [],
};

describe('extractMetadata', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('extracts all metadata fields from Ollama response', async () => {
    mockFetch
      .mockResolvedValueOnce(mockOllamaResponse(fullExtraction))
      .mockResolvedValueOnce(mockOllamaResponse(emptyGleaning));

    const result = await extractMetadata('Meeting with Alice and Bob about Q1 planning', baseConfig);

    expect(result.thought_type).toBe('meeting_note');
    expect(result.people).toEqual(['Alice', 'Bob']);
    expect(result.topics).toEqual(['Q1 planning']);
    expect(result.action_items).toEqual(['Draft proposal']);
    expect(result.sentiment).toBe('positive');
    expect(result.summary).toBe('Met with Alice and Bob about Q1');
    expect(result.companies).toEqual(['Acme Corp']);
    expect(result.products).toEqual(['Widget Pro']);
    expect(result.projects).toEqual(['Project Alpha']);
    expect(result.department).toBe('engineering');
    expect(result.confidentiality).toBe('internal');
    expect(result.themes).toEqual(['product_strategy']);
    expect(result.key_decisions).toEqual(['Launch beta by March 15']);
    expect(result.key_insights).toEqual(['LTI 1.3 requires SSO passthrough']);
    expect(result.meeting_participants).toEqual(['Alice', 'Bob']);
    expect(result.action_items_structured).toEqual([{ action: 'Draft proposal', assignee: 'Alice', deadline: null, status: 'open' }]);
  });

  it('sends correct JSON schema for constrained decoding', async () => {
    mockFetch.mockResolvedValueOnce(mockOllamaResponse({
      thought_type: null, people: [], topics: [], action_items: [],
      dates_mentioned: [], sentiment: null, summary: null,
    }));

    await extractMetadata('Some text', { ...baseConfig, enableGleaning: false });

    const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(callBody.format).toBeDefined();
    expect(callBody.model).toBe('llama3.3:70b');
    expect(callBody.stream).toBe(false);
  });

  it('includes timeout signal in fetch call', async () => {
    mockFetch.mockResolvedValueOnce(mockOllamaResponse({
      thought_type: null, people: [], topics: [], action_items: [],
      dates_mentioned: [], sentiment: null, summary: null,
    }));

    await extractMetadata('Some text', { ...baseConfig, enableGleaning: false });

    expect(mockFetch.mock.calls[0][1].signal).toBeDefined();
  });

  it('includes new fields in schema sent to Ollama', async () => {
    mockFetch.mockResolvedValueOnce(mockOllamaResponse({
      thought_type: null, people: [], topics: [], action_items: [],
      dates_mentioned: [], sentiment: null, summary: null,
    }));

    await extractMetadata('Some text', { ...baseConfig, enableGleaning: false });

    const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(callBody.format.properties.department).toBeDefined();
    expect(callBody.format.properties.confidentiality).toBeDefined();
    expect(callBody.format.properties.themes).toBeDefined();
    expect(callBody.format.properties.key_decisions).toBeDefined();
    expect(callBody.format.properties.key_insights).toBeDefined();
    expect(callBody.format.properties.meeting_participants).toBeDefined();
    expect(callBody.format.properties.action_items_structured).toBeDefined();
  });

  it('handles missing fields gracefully with defaults', async () => {
    mockFetch.mockResolvedValueOnce(mockOllamaResponse({ thought_type: 'idea' }));

    await extractMetadata('Just an idea', { ...baseConfig, enableGleaning: false });

    // Gleaning disabled — only 1 fetch call
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('includes companies/products/projects in schema sent to Ollama', async () => {
    mockFetch.mockResolvedValueOnce(mockOllamaResponse({
      thought_type: null, people: [], topics: [], action_items: [],
      dates_mentioned: [], sentiment: null, summary: null,
      companies: [], products: [], projects: [],
    }));

    await extractMetadata('Some text', { ...baseConfig, enableGleaning: false });

    const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(callBody.format.properties.companies).toBeDefined();
    expect(callBody.format.properties.products).toBeDefined();
    expect(callBody.format.properties.projects).toBeDefined();
  });

  it('uses detailed system prompt with DO/DON\'T rules and examples', async () => {
    mockFetch.mockResolvedValueOnce(mockOllamaResponse({
      thought_type: 'observation', people: [], topics: [], action_items: [],
      dates_mentioned: [], sentiment: 'neutral', summary: 'Test',
      companies: [], products: [], projects: [],
    }));

    await extractMetadata('Some text', { ...baseConfig, enableGleaning: false });

    const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    const systemMsg = callBody.messages.find((m: { role: string }) => m.role === 'system');
    expect(systemMsg.content).toContain("DON'T");
    expect(systemMsg.content).toContain('DO:');
    expect(systemMsg.content).toContain('EXAMPLE 1:');
    expect(systemMsg.content).toContain('EXAMPLE 2');
    expect(systemMsg.content).toContain('knowledge management');
    expect(systemMsg.content).toContain('chris@topia.io');
    expect(systemMsg.content).toContain('Topia.io');
    expect(systemMsg.content).toContain('Phase 4');
  });

  it('throws on Ollama error', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: () => Promise.resolve('Model not found'),
    });

    await expect(
      extractMetadata('Test', { ...baseConfig, enableGleaning: false })
    ).rejects.toThrow();
  });
});

describe('gleaning', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('makes two Ollama calls by default (extraction + gleaning)', async () => {
    mockFetch
      .mockResolvedValueOnce(mockOllamaResponse(fullExtraction))
      .mockResolvedValueOnce(mockOllamaResponse(emptyGleaning));

    await extractMetadata('Meeting text', baseConfig);

    expect(mockFetch).toHaveBeenCalledTimes(2);

    // Second call uses gleaning schema and prompt
    const gleanBody = JSON.parse(mockFetch.mock.calls[1][1].body);
    const systemMsg = gleanBody.messages.find((m: { role: string }) => m.role === 'system');
    expect(systemMsg.content).toContain('MISSED');
    expect(gleanBody.format.properties.additional_people).toBeDefined();
    expect(gleanBody.format.properties.additional_companies).toBeDefined();
  });

  it('merges gleaned entities into base extraction', async () => {
    mockFetch
      .mockResolvedValueOnce(mockOllamaResponse(fullExtraction))
      .mockResolvedValueOnce(mockOllamaResponse({
        additional_people: ['Carol'],
        additional_companies: ['Beta Inc'],
        additional_products: [],
        additional_projects: ['DanielBrain'],
        additional_action_items: ['Carol to review docs'],
      }));

    const result = await extractMetadata('Meeting text', baseConfig);

    expect(result.people).toEqual(['Alice', 'Bob', 'Carol']);
    expect(result.companies).toEqual(['Acme Corp', 'Beta Inc']);
    expect(result.projects).toEqual(['Project Alpha', 'DanielBrain']);
    expect(result.action_items).toEqual(['Draft proposal', 'Carol to review docs']);
    // Non-merged fields stay the same
    expect(result.thought_type).toBe('meeting_note');
    expect(result.sentiment).toBe('positive');
  });

  it('deduplicates gleaned entities (case-insensitive)', async () => {
    mockFetch
      .mockResolvedValueOnce(mockOllamaResponse(fullExtraction))
      .mockResolvedValueOnce(mockOllamaResponse({
        additional_people: ['alice', 'Bob', 'Carol'],  // alice and Bob are duplicates
        additional_companies: ['acme corp'],            // duplicate
        additional_products: [],
        additional_projects: [],
        additional_action_items: [],
      }));

    const result = await extractMetadata('Meeting text', baseConfig);

    expect(result.people).toEqual(['Alice', 'Bob', 'Carol']);
    expect(result.companies).toEqual(['Acme Corp']);
  });

  it('skips gleaning when enableGleaning is false', async () => {
    mockFetch.mockResolvedValueOnce(mockOllamaResponse(fullExtraction));

    const result = await extractMetadata('Meeting text', { ...baseConfig, enableGleaning: false });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(result.people).toEqual(['Alice', 'Bob']);
  });

  it('falls back to base extraction if gleaning fails', async () => {
    mockFetch
      .mockResolvedValueOnce(mockOllamaResponse(fullExtraction))
      .mockResolvedValueOnce({ ok: false, status: 500, text: () => Promise.resolve('error') });

    const result = await extractMetadata('Meeting text', baseConfig);

    // Should return base extraction without error
    expect(result.people).toEqual(['Alice', 'Bob']);
    expect(result.companies).toEqual(['Acme Corp']);
  });

  it('includes already-extracted entities in gleaning prompt', async () => {
    mockFetch
      .mockResolvedValueOnce(mockOllamaResponse(fullExtraction))
      .mockResolvedValueOnce(mockOllamaResponse(emptyGleaning));

    await extractMetadata('Meeting text', baseConfig);

    const gleanBody = JSON.parse(mockFetch.mock.calls[1][1].body);
    const userMsg = gleanBody.messages.find((m: { role: string }) => m.role === 'user');
    // Should contain the already-extracted entities for context
    expect(userMsg.content).toContain('Alice');
    expect(userMsg.content).toContain('Bob');
    expect(userMsg.content).toContain('Acme Corp');
    expect(userMsg.content).toContain('ALREADY EXTRACTED');
  });

  it('merges gleaned new fields (key_decisions, key_insights, themes, participants)', async () => {
    mockFetch
      .mockResolvedValueOnce(mockOllamaResponse(fullExtraction))
      .mockResolvedValueOnce(mockOllamaResponse({
        additional_people: [],
        additional_companies: [],
        additional_products: [],
        additional_projects: [],
        additional_action_items: [],
        additional_key_decisions: ['Hire two more engineers'],
        additional_key_insights: ['Budget is tight'],
        additional_meeting_participants: ['Carol'],
        additional_themes: ['hiring'],
      }));

    const result = await extractMetadata('Meeting text', baseConfig);

    expect(result.key_decisions).toContain('Launch beta by March 15');
    expect(result.key_decisions).toContain('Hire two more engineers');
    expect(result.key_insights).toContain('Budget is tight');
    expect(result.meeting_participants).toContain('Carol');
    expect(result.themes).toContain('hiring');
  });

  it('exports gleaning schema and prompt for inspection', () => {
    expect(GLEANING_SYSTEM_PROMPT).toContain('MISSED');
    expect(GLEANING_SCHEMA.properties.additional_people).toBeDefined();
    expect(GLEANING_SCHEMA.properties.additional_action_items).toBeDefined();
    expect(GLEANING_SCHEMA.properties.additional_key_decisions).toBeDefined();
    expect(GLEANING_SCHEMA.properties.additional_key_insights).toBeDefined();
    expect(GLEANING_SCHEMA.properties.additional_themes).toBeDefined();
  });
});
