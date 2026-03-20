import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMcpServer } from '../../src/mcp/server.js';

// Mock all tool handlers to avoid pulling in real dependencies
vi.mock('../../src/mcp/tools/semantic-search.js', () => ({ handleSemanticSearch: vi.fn().mockResolvedValue([]) }));
vi.mock('../../src/mcp/tools/list-recent.js', () => ({ handleListRecent: vi.fn().mockResolvedValue([]) }));
vi.mock('../../src/mcp/tools/stats.js', () => ({ handleStats: vi.fn().mockResolvedValue({}) }));
vi.mock('../../src/mcp/tools/save-thought.js', () => ({ handleSaveThought: vi.fn().mockResolvedValue({ id: 't1' }) }));
vi.mock('../../src/mcp/tools/get-entity.js', () => ({ handleGetEntity: vi.fn().mockResolvedValue({}) }));
vi.mock('../../src/mcp/tools/list-entities.js', () => ({ handleListEntities: vi.fn().mockResolvedValue([]) }));
vi.mock('../../src/mcp/tools/get-context.js', () => ({ handleGetContext: vi.fn().mockResolvedValue({}) }));
vi.mock('../../src/mcp/tools/get-timeline.js', () => ({ handleGetTimeline: vi.fn().mockResolvedValue({}) }));
vi.mock('../../src/mcp/tools/query-relationships.js', () => ({ handleQueryRelationships: vi.fn().mockResolvedValue([]) }));
vi.mock('../../src/mcp/tools/update-thought.js', () => ({ handleUpdateThought: vi.fn().mockResolvedValue({ ok: true }) }));
vi.mock('../../src/mcp/tools/propose-relationship.js', () => ({ handleProposeRelationship: vi.fn().mockResolvedValue({ ok: true }) }));
vi.mock('../../src/mcp/tools/get-communities.js', () => ({ handleGetCommunities: vi.fn().mockResolvedValue([]) }));
vi.mock('../../src/mcp/tools/global-search.js', () => ({ handleGlobalSearch: vi.fn().mockResolvedValue([]) }));
vi.mock('../../src/mcp/tools/update-entity.js', () => ({ handleUpdateEntity: vi.fn().mockResolvedValue({ ok: true }) }));
vi.mock('../../src/mcp/tools/propose-merge.js', () => ({ handleProposeMerge: vi.fn().mockResolvedValue({ ok: true }) }));
vi.mock('../../src/mcp/tools/ask.js', () => ({ handleAsk: vi.fn().mockResolvedValue({ thoughts: [], entities: [] }) }));
vi.mock('../../src/mcp/tools/deep-research.js', () => ({ handleDeepResearch: vi.fn().mockResolvedValue({ findings: [] }) }));

const mockPool = { query: vi.fn() } as any;
const mockConfig = {
  ollamaBaseUrl: 'http://localhost:11434',
  embeddingModel: 'nomic-embed-text',
  extractionModel: 'llama3.3:70b',
} as any;

/** Helper: get the _registeredTools plain object from an McpServer */
function getTools(server: any): Record<string, any> {
  return server._registeredTools;
}

describe('createMcpServer', () => {
  beforeEach(() => vi.clearAllMocks());

  it('creates a server instance', () => {
    const server = createMcpServer(mockPool, mockConfig);
    expect(server).toBeDefined();
  });

  it('registers without throwing', () => {
    expect(() => createMcpServer(mockPool, mockConfig)).not.toThrow();
  });

  it('registers exactly 17 tools', () => {
    const server = createMcpServer(mockPool, mockConfig);
    const tools = getTools(server);
    expect(tools).toBeDefined();
    expect(Object.keys(tools).length).toBe(17);
  });

  it('registers all expected tool names', () => {
    const server = createMcpServer(mockPool, mockConfig);
    const toolNames = Object.keys(getTools(server));

    const expectedTools = [
      'ask',
      'deep_research',
      'semantic_search',
      'list_recent',
      'stats',
      'save_thought',
      'update_thought',
      'get_entity',
      'list_entities',
      'get_context',
      'get_timeline',
      'update_entity',
      'propose_merge',
      'query_relationships',
      'propose_relationship',
      'get_communities',
      'global_search',
    ];

    for (const name of expectedTools) {
      expect(toolNames).toContain(name);
    }
  });

  it('returns a new server object on each call', () => {
    const server1 = createMcpServer(mockPool, mockConfig);
    const server2 = createMcpServer(mockPool, mockConfig);
    expect(server1).not.toBe(server2);
  });
});

describe('getVisibility (via tool behavior)', () => {
  // getVisibility is a private function inside server.ts. We test it indirectly by
  // verifying that tool handlers receive the correct visibility argument based on
  // the extra.authInfo.extra.visibilityTags passed to the tool callback.

  let handleSemanticSearch: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    const mod = await import('../../src/mcp/tools/semantic-search.js');
    handleSemanticSearch = mod.handleSemanticSearch as ReturnType<typeof vi.fn>;
  });

  it('passes null visibility when extra has no authInfo', async () => {
    const server = createMcpServer(mockPool, mockConfig);
    const tool = getTools(server)['semantic_search'];
    await tool.handler({ query: 'test' }, {});

    expect(handleSemanticSearch).toHaveBeenCalledWith(
      expect.anything(),
      mockPool,
      mockConfig,
      null,
    );
  });

  it('passes null visibility when authInfo has no extra', async () => {
    const server = createMcpServer(mockPool, mockConfig);
    const tool = getTools(server)['semantic_search'];
    await tool.handler({ query: 'test' }, { authInfo: {} });

    expect(handleSemanticSearch).toHaveBeenCalledWith(
      expect.anything(),
      mockPool,
      mockConfig,
      null,
    );
  });

  it('passes null visibility when visibilityTags is empty array', async () => {
    const server = createMcpServer(mockPool, mockConfig);
    const tool = getTools(server)['semantic_search'];
    await tool.handler({ query: 'test' }, {
      authInfo: { extra: { visibilityTags: [] } },
    });

    expect(handleSemanticSearch).toHaveBeenCalledWith(
      expect.anything(),
      mockPool,
      mockConfig,
      null,
    );
  });

  it('passes null visibility when visibilityTags is not an array', async () => {
    const server = createMcpServer(mockPool, mockConfig);
    const tool = getTools(server)['semantic_search'];
    await tool.handler({ query: 'test' }, {
      authInfo: { extra: { visibilityTags: 'not-an-array' } },
    });

    expect(handleSemanticSearch).toHaveBeenCalledWith(
      expect.anything(),
      mockPool,
      mockConfig,
      null,
    );
  });

  it('passes tags when visibilityTags is a non-empty array', async () => {
    const server = createMcpServer(mockPool, mockConfig);
    const tool = getTools(server)['semantic_search'];
    const tags = ['company', 'user:abc-123'];
    await tool.handler({ query: 'test' }, {
      authInfo: { extra: { visibilityTags: tags } },
    });

    expect(handleSemanticSearch).toHaveBeenCalledWith(
      expect.anything(),
      mockPool,
      mockConfig,
      tags,
    );
  });

  it('passes null visibility when extra is null', async () => {
    const server = createMcpServer(mockPool, mockConfig);
    const tool = getTools(server)['semantic_search'];
    await tool.handler({ query: 'test' }, null);

    expect(handleSemanticSearch).toHaveBeenCalledWith(
      expect.anything(),
      mockPool,
      mockConfig,
      null,
    );
  });
});

describe('tool-level validation', () => {
  beforeEach(() => vi.clearAllMocks());

  it('get_entity returns isError when neither entity_id nor name provided', async () => {
    const server = createMcpServer(mockPool, mockConfig);
    const tool = getTools(server)['get_entity'];
    const result = await tool.handler({}, {});

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toContain('entity_id or name');
  });

  it('get_timeline returns isError when neither entity_id nor entity_name provided', async () => {
    const server = createMcpServer(mockPool, mockConfig);
    const tool = getTools(server)['get_timeline'];
    const result = await tool.handler({}, {});

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toContain('entity_id or entity_name');
  });

  it('query_relationships returns isError when neither entity_id nor entity_name provided', async () => {
    const server = createMcpServer(mockPool, mockConfig);
    const tool = getTools(server)['query_relationships'];
    const result = await tool.handler({}, {});

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toContain('entity_id or entity_name');
  });

  it('update_entity returns isError when neither entity_id nor name provided', async () => {
    const server = createMcpServer(mockPool, mockConfig);
    const tool = getTools(server)['update_entity'];
    const result = await tool.handler({}, {});

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toContain('entity_id or name');
  });

  it('deep_research catches handler errors and returns isError', async () => {
    const { handleDeepResearch } = await import('../../src/mcp/tools/deep-research.js');
    (handleDeepResearch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('LLM timeout'));

    const server = createMcpServer(mockPool, mockConfig);
    const tool = getTools(server)['deep_research'];
    const result = await tool.handler({ question: 'What happened?' }, {});

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toBe('LLM timeout');
  });

  it('deep_research sets isError when result contains error key', async () => {
    const { handleDeepResearch } = await import('../../src/mcp/tools/deep-research.js');
    (handleDeepResearch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ error: 'decomposition failed' });

    const server = createMcpServer(mockPool, mockConfig);
    const tool = getTools(server)['deep_research'];
    const result = await tool.handler({ question: 'What happened?' }, {});

    expect(result.isError).toBe(true);
  });

  it('get_entity catches handler errors and returns isError', async () => {
    const { handleGetEntity } = await import('../../src/mcp/tools/get-entity.js');
    (handleGetEntity as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('DB down'));

    const server = createMcpServer(mockPool, mockConfig);
    const tool = getTools(server)['get_entity'];
    const result = await tool.handler({ name: 'Chris' }, {});

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toBe('DB down');
  });

  it('update_thought sets isError when result contains error key', async () => {
    const { handleUpdateThought } = await import('../../src/mcp/tools/update-thought.js');
    (handleUpdateThought as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ error: 'not found' });

    const server = createMcpServer(mockPool, mockConfig);
    const tool = getTools(server)['update_thought'];
    const result = await tool.handler(
      { thought_id: '00000000-0000-0000-0000-000000000001', summary: 'new' },
      {},
    );

    expect(result.isError).toBe(true);
  });
});
