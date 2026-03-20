import { describe, it, expect, vi, beforeEach } from 'vitest';
import { processThought, parseEnvelope } from '../../src/processor/pipeline.js';
import * as embedder from '../../src/processor/embedder.js';
import * as extractor from '../../src/processor/extractor.js';
import * as chunker from '../../src/processor/chunker.js';
import * as summarizer from '../../src/processor/summarizer.js';
import type { ThoughtMetadata } from '@danielbrain/shared';

vi.mock('../../src/processor/embedder.js');
vi.mock('../../src/processor/extractor.js');
vi.mock('../../src/processor/chunker.js', async () => {
  const actual = await vi.importActual('../../src/processor/chunker.js');
  return {
    ...actual,
    // Let real chunker logic work, we test it separately
  };
});
vi.mock('../../src/processor/summarizer.js');
vi.mock('../../src/processor/entity-resolver.js', () => ({
  resolveEntities: vi.fn().mockResolvedValue(undefined),
}));

const mockClient = {
  query: vi.fn(),
  release: vi.fn(),
};

const mockPool = {
  query: vi.fn(),
  connect: vi.fn().mockResolvedValue(mockClient),
};

const mockConfig = {
  ollamaBaseUrl: 'http://localhost:11434',
  embeddingModel: 'nomic-embed-text',
  extractionModel: 'llama3.3:70b',
};

const sampleMetadata: ThoughtMetadata = {
  thought_type: 'idea',
  people: ['Alice'],
  topics: ['AI'],
  action_items: [],
  dates_mentioned: [],
  sentiment: 'positive',
  summary: 'An idea about AI',
  companies: [],
  products: [],
  projects: [],
  department: null,
  confidentiality: 'internal',
  themes: [],
  key_decisions: [],
  key_insights: [],
  meeting_participants: [],
  action_items_structured: [],
};

describe('parseEnvelope', () => {
  it('returns empty structured and manual channel_type for null source_meta', () => {
    const result = parseEnvelope(null);
    expect(result.structured).toEqual({});
    expect(result.channelType).toBe('manual');
  });

  it('extracts structured and channel_type from source_meta', () => {
    const result = parseEnvelope({
      channel_type: 'meeting',
      structured: { summary: 'Quick sync call.' },
    });
    expect(result.structured.summary).toBe('Quick sync call.');
    expect(result.channelType).toBe('meeting');
  });

  it('defaults to empty structured when not present', () => {
    const result = parseEnvelope({ channel: 'C12345' });
    expect(result.structured).toEqual({});
    expect(result.channelType).toBe('manual');
  });
});

describe('processThought', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPool.query.mockResolvedValue({ rows: [{ id: 'thought-uuid-1' }] });
    vi.mocked(embedder.embed).mockResolvedValue([0.1, 0.2, 0.3]);
    vi.mocked(embedder.embedBatch).mockImplementation(async (texts: string[]) =>
      texts.map(() => [0.1, 0.2, 0.3])
    );
    vi.mocked(extractor.extractMetadata).mockResolvedValue(sampleMetadata);
    vi.mocked(summarizer.summarize).mockResolvedValue('Summary text');
  });

  it('processes short content with parallel embed + extract', async () => {
    const result = await processThought(
      'Short thought about AI',
      'manual',
      mockPool as any,
      mockConfig
    );

    expect(embedder.embed).toHaveBeenCalledWith('Short thought about AI', mockConfig);
    expect(extractor.extractMetadata).toHaveBeenCalledWith('Short thought about AI', mockConfig);
    expect(result.id).toBe('thought-uuid-1');
    expect(result.metadata).toEqual(sampleMetadata);
  });

  it('stores raw text in thoughts table', async () => {
    await processThought('My thought', 'manual', mockPool as any, mockConfig);

    const insertCall = mockPool.query.mock.calls[0];
    expect(insertCall[0]).toContain('INSERT INTO thoughts');
    expect(insertCall[1]).toContain('My thought');
  });

  it('includes new extraction columns in INSERT', async () => {
    await processThought('My thought', 'manual', mockPool as any, mockConfig);

    const insertCall = mockPool.query.mock.calls[0];
    expect(insertCall[0]).toContain('key_decisions');
    expect(insertCall[0]).toContain('key_insights');
    expect(insertCall[0]).toContain('themes');
    expect(insertCall[0]).toContain('department');
    expect(insertCall[0]).toContain('confidentiality');
    expect(insertCall[0]).toContain('meeting_participants');
    expect(insertCall[0]).toContain('action_items_structured');
  });

  it('processes long content with chunking', async () => {
    const longText = 'This is a long sentence about various topics. '.repeat(700);
    mockClient.query.mockResolvedValue({ rows: [] });

    // needsChunking will return true for this
    await processThought(longText, 'slack', mockPool as any, mockConfig);

    // Should have called summarize for long content
    expect(summarizer.summarize).toHaveBeenCalled();
    // Should embed summary for parent
    expect(embedder.embed).toHaveBeenCalled();
    // Chunk inserts go through client (transaction)
    expect(mockPool.connect).toHaveBeenCalled();
    expect(mockClient.query).toHaveBeenCalled();
    expect(mockClient.release).toHaveBeenCalled();
  });

  it('skips summarizer when structured.summary is available (long content)', async () => {
    const longText = 'This is a long sentence about various topics. '.repeat(700);
    const sourceMeta = {
      channel_type: 'meeting',
      structured: {
        summary: 'Pre-computed meeting summary.',
      },
    };
    mockClient.query.mockResolvedValue({ rows: [] });

    await processThought(longText, 'fathom', mockPool as any, mockConfig, sourceMeta, 'fathom-123');

    // Summarizer should NOT be called — structured summary used instead
    expect(summarizer.summarize).not.toHaveBeenCalled();
    // Embed should still be called (for the summary embedding)
    expect(embedder.embed).toHaveBeenCalled();
  });

  it('merges structured action items with LLM-extracted ones', async () => {
    const metaWithActions: ThoughtMetadata = {
      ...sampleMetadata,
      action_items: ['LLM found: Alice should review docs'],
    };
    vi.mocked(extractor.extractMetadata).mockResolvedValue(metaWithActions);

    const sourceMeta = {
      structured: {
        action_items: [
          { description: 'Bob sends report', assignee_name: 'Bob', assignee_email: null, completed: false },
          // Duplicate of LLM item (same first 30 chars won't match, so it gets added)
          { description: 'New structured item', assignee_name: null, assignee_email: null, completed: false },
        ],
      },
    };

    const result = await processThought('Short thought', 'fathom', mockPool as any, mockConfig, sourceMeta);

    expect(result.metadata.action_items).toContain('LLM found: Alice should review docs');
    expect(result.metadata.action_items).toContain('Bob sends report (Bob)');
    expect(result.metadata.action_items).toContain('New structured item');
  });

  it('deduplicates action items by first 30 chars', async () => {
    const metaWithActions: ThoughtMetadata = {
      ...sampleMetadata,
      action_items: ['Send report to the team by Friday'],
    };
    vi.mocked(extractor.extractMetadata).mockResolvedValue(metaWithActions);

    const sourceMeta = {
      structured: {
        action_items: [
          // Same first 30 chars as LLM item
          { description: 'Send report to the team by Friday afternoon', assignee_name: null, assignee_email: null, completed: false },
        ],
      },
    };

    const result = await processThought('Short thought', 'fathom', mockPool as any, mockConfig, sourceMeta);

    // Should not duplicate — only the original LLM version kept
    expect(result.metadata.action_items).toHaveLength(1);
  });

  it('uses ON CONFLICT upsert for idempotent retries (short)', async () => {
    await processThought('Test thought', 'fathom', mockPool as any, mockConfig, null, 'fathom-123');

    const insertCall = mockPool.query.mock.calls[0];
    expect(insertCall[0]).toContain('ON CONFLICT (source_id)');
    expect(insertCall[0]).toContain('DO UPDATE SET');
  });

  it('uses ON CONFLICT upsert for parent in long content', async () => {
    const longText = 'This is a long sentence about various topics. '.repeat(700);
    mockClient.query.mockResolvedValue({ rows: [] });
    await processThought(longText, 'fathom', mockPool as any, mockConfig, null, 'fathom-456');

    // Parent insert goes through pool (not client)
    const insertCall = mockPool.query.mock.calls[0];
    expect(insertCall[0]).toContain('ON CONFLICT (source_id)');
    expect(insertCall[0]).toContain('DO UPDATE SET');
  });

  it('deletes old chunks before re-inserting in long content', async () => {
    const longText = 'This is a long sentence about various topics. '.repeat(700);
    mockClient.query.mockResolvedValue({ rows: [] });
    await processThought(longText, 'fathom', mockPool as any, mockConfig, null, 'fathom-789');

    // Chunk cleanup (DELETE) now goes through client (transaction)
    const deleteCall = mockClient.query.mock.calls.find(
      (call: any[]) => typeof call[0] === 'string' && call[0].includes('DELETE FROM thoughts WHERE parent_id')
    );
    expect(deleteCall).toBeDefined();
  });

  it('returns extracted metadata', async () => {
    const result = await processThought('Test thought', 'manual', mockPool as any, mockConfig);

    expect(result.metadata.thought_type).toBe('idea');
    expect(result.metadata.people).toEqual(['Alice']);
  });

  it('passes source through to DB insert', async () => {
    await processThought('Test', 'slack', mockPool as any, mockConfig);

    const insertCall = mockPool.query.mock.calls[0];
    expect(insertCall[1]).toContain('slack');
  });
});
