import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  summarizeCommunity,
  summarizeUnsummarizedCommunities,
  COMMUNITY_SUMMARY_SYSTEM_PROMPT,
} from '../../src/processor/community-summarizer.js';

vi.mock('../../src/processor/embedder.js', () => ({
  embed: vi.fn().mockResolvedValue(new Array(768).fill(0.1)),
}));

import { embed } from '../../src/processor/embedder.js';

const mockPool = {
  query: vi.fn(),
};

const mockConfig = {
  ollamaBaseUrl: 'http://localhost:11434',
  embeddingModel: 'nomic-embed-text',
  extractionModel: 'llama3.3:70b',
};

const mockFetchResponse = (content: string) => ({
  ok: true,
  json: () => Promise.resolve({ message: { content } }),
  text: () => Promise.resolve(content),
});

describe('summarizeCommunity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', vi.fn());
  });

  it('returns null when community has no members', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    const result = await summarizeCommunity('comm-1', mockPool as any, mockConfig);
    expect(result).toBeNull();
  });

  it('generates summary and embeds it', async () => {
    // Members
    mockPool.query.mockResolvedValueOnce({
      rows: [
        { id: 'e1', name: 'Alice', entity_type: 'person', profile_summary: 'Engineer at Acme', mention_count: 10 },
        { id: 'e2', name: 'Bob', entity_type: 'person', profile_summary: null, mention_count: 5 },
      ],
    });

    // Relationships between members
    mockPool.query.mockResolvedValueOnce({
      rows: [
        { description: 'Alice and Bob work on the platform team.', source_name: 'Alice', target_name: 'Bob' },
      ],
    });

    // Thoughts
    mockPool.query.mockResolvedValueOnce({
      rows: [
        { summary: 'Platform architecture discussion', content: 'long content', source: 'slack', created_at: new Date() },
      ],
    });

    // LLM response
    const llmResponse = JSON.stringify({
      title: 'Platform Engineering Team',
      summary: 'Alice and Bob work together on the platform team.',
      full_report: 'Alice and Bob are engineers who collaborate on platform architecture and design.',
    });
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(mockFetchResponse(llmResponse));

    // Update community
    mockPool.query.mockResolvedValueOnce({ rows: [] });

    const result = await summarizeCommunity('comm-1', mockPool as any, mockConfig);

    expect(result).toEqual({
      title: 'Platform Engineering Team',
      summary: 'Alice and Bob work together on the platform team.',
      full_report: 'Alice and Bob are engineers who collaborate on platform architecture and design.',
    });

    // Verify LLM was called with correct system prompt
    const fetchCall = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(fetchCall[1].body);
    expect(body.messages[0].content).toBe(COMMUNITY_SUMMARY_SYSTEM_PROMPT);
    expect(body.model).toBe('llama3.3:70b');

    // Verify embedding was called
    expect(embed).toHaveBeenCalledWith(
      'Alice and Bob work together on the platform team.',
      mockConfig
    );

    // Verify DB update — find the UPDATE communities call
    const updateCall = mockPool.query.mock.calls.find(
      (call: any[]) => typeof call[0] === 'string' && call[0].includes('UPDATE communities')
    );
    expect(updateCall).toBeDefined();
    expect(updateCall![1][0]).toBe('Platform Engineering Team');
  });

  it('handles LLM returning JSON wrapped in text', async () => {
    // Members
    mockPool.query.mockResolvedValueOnce({
      rows: [{ id: 'e1', name: 'Alice', entity_type: 'person', profile_summary: null, mention_count: 5 }],
    });
    // Relationships
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    // Thoughts
    mockPool.query.mockResolvedValueOnce({
      rows: [{ summary: 'Some context', content: 'text', source: 'slack', created_at: new Date() }],
    });

    // LLM returns JSON wrapped in explanation
    const wrappedResponse = 'Here is the analysis:\n' + JSON.stringify({
      title: 'Test Group',
      summary: 'A test group.',
      full_report: 'Detailed report about the test group.',
    }) + '\nDone.';
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(mockFetchResponse(wrappedResponse));

    // Update
    mockPool.query.mockResolvedValueOnce({ rows: [] });

    const result = await summarizeCommunity('comm-1', mockPool as any, mockConfig);
    expect(result?.title).toBe('Test Group');
  });

  it('throws on malformed LLM response', async () => {
    // Members
    mockPool.query.mockResolvedValueOnce({
      rows: [{ id: 'e1', name: 'Alice', entity_type: 'person', profile_summary: null, mention_count: 5 }],
    });
    // Relationships
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    // Thoughts
    mockPool.query.mockResolvedValueOnce({
      rows: [{ summary: 'Context', content: 'text', source: 'slack', created_at: new Date() }],
    });

    // LLM returns non-JSON
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      mockFetchResponse('I cannot parse this input properly.')
    );

    await expect(summarizeCommunity('comm-1', mockPool as any, mockConfig))
      .rejects.toThrow('Failed to parse community summary');
  });

  it('throws on missing required fields in JSON', async () => {
    mockPool.query.mockResolvedValueOnce({
      rows: [{ id: 'e1', name: 'Alice', entity_type: 'person', profile_summary: null, mention_count: 5 }],
    });
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    mockPool.query.mockResolvedValueOnce({
      rows: [{ summary: 'Context', content: 'text', source: 'slack', created_at: new Date() }],
    });

    // Missing full_report
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      mockFetchResponse('{"title": "Test", "summary": "Test summary"}')
    );

    await expect(summarizeCommunity('comm-1', mockPool as any, mockConfig))
      .rejects.toThrow('Missing required fields');
  });
});

describe('summarizeUnsummarizedCommunities', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', vi.fn());
  });

  it('queries for communities with NULL summary', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] });

    await summarizeUnsummarizedCommunities(mockPool as any, mockConfig);

    const [sql] = mockPool.query.mock.calls[0];
    expect(sql).toContain('summary IS NULL');
  });

  it('returns count of summarized communities', async () => {
    // Find 1 unsummarized community
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 'comm-1' }] });

    // summarizeCommunity calls: members, relationships, thoughts
    mockPool.query.mockResolvedValueOnce({
      rows: [{ id: 'e1', name: 'Alice', entity_type: 'person', profile_summary: null, mention_count: 5 }],
    });
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    mockPool.query.mockResolvedValueOnce({
      rows: [{ summary: 'Context', content: 'text', source: 'slack', created_at: new Date() }],
    });

    const llmResponse = JSON.stringify({
      title: 'Test',
      summary: 'Test summary.',
      full_report: 'Test report.',
    });
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(mockFetchResponse(llmResponse));

    // Update
    mockPool.query.mockResolvedValueOnce({ rows: [] });

    const count = await summarizeUnsummarizedCommunities(mockPool as any, mockConfig);
    expect(count).toBe(1);
  });

  it('continues on individual failures', async () => {
    // 2 communities
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 'comm-1' }, { id: 'comm-2' }] });

    // comm-1: no members → returns null
    mockPool.query.mockResolvedValueOnce({ rows: [] });

    // comm-2: succeeds
    mockPool.query.mockResolvedValueOnce({
      rows: [{ id: 'e1', name: 'Bob', entity_type: 'person', profile_summary: null, mention_count: 3 }],
    });
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    mockPool.query.mockResolvedValueOnce({
      rows: [{ summary: 'Context', content: 'text', source: 'slack', created_at: new Date() }],
    });

    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      mockFetchResponse(JSON.stringify({ title: 'G2', summary: 'S2.', full_report: 'R2.' }))
    );
    mockPool.query.mockResolvedValueOnce({ rows: [] });

    const count = await summarizeUnsummarizedCommunities(mockPool as any, mockConfig);
    expect(count).toBe(1); // Only comm-2 succeeded
  });
});
