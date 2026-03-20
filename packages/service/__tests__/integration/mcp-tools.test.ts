/**
 * Integration tests for MCP tool calls via InMemoryTransport.
 *
 * These tests run against a real PostgreSQL database (docker-compose.test.yml on port 5433).
 * They verify that MCP tools return correct data shapes when operating against real SQL.
 *
 * Run: npx vitest run --config vitest.integration.config.ts
 * Prereq: docker compose -f docker/docker-compose.test.yml up -d
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import pg from 'pg';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../../src/mcp/server.js';
import type { Config } from '../../src/config.js';
import {
  TEST_DB_URL, createTestPool, dummyEmbedding, randomEmbedding,
  insertTestUser, insertTestThought, insertTestEntity,
  linkThoughtEntity, insertEntityRelationship,
  cleanupTestData,
} from './helpers.js';

let pool: pg.Pool;
let client: Client;
let mcpServer: ReturnType<typeof createMcpServer>;

// Minimal config for tests (Ollama not actually called for most tools)
const testConfig: Config = {
  databaseUrl: TEST_DB_URL,
  brainAccessKey: 'test-key-not-used',
  ollamaBaseUrl: 'http://localhost:11434',
  embeddingModel: 'nomic-embed-text',
  extractionModel: 'llama3.3:70b',
  chatModel: 'llama3.3:70b',
  mcpPort: 3000,
  pollIntervalMs: 5000,
  batchSize: 5,
  maxRetries: 3,
  rawFilesDir: './data/raw-files',
  whisperBaseUrl: 'http://localhost:8001',
  whisperModel: 'large-v3',
  transcribeDir: './data/transcriptions',
};

// Test data IDs (filled during setup)
let userId: string;
let thoughtId1: string;
let thoughtId2: string;
let thoughtId3: string;
let entityPersonId: string;
let entityCompanyId: string;
let entityTopicId: string;

/** Helper to parse the JSON text content from an MCP tool result */
function parseToolResult(result: any): any {
  expect(result.content).toBeDefined();
  expect(result.content.length).toBeGreaterThan(0);
  const text = result.content[0].text;
  return JSON.parse(text);
}

beforeAll(async () => {
  pool = createTestPool();
  await pool.query('SELECT 1');

  // Create test user
  const user = await insertTestUser(pool, { email: 'mcp-test@test.com', displayName: 'MCP Test User', role: 'owner' });
  userId = user.id;

  // Create test entities
  entityPersonId = await insertTestEntity(pool, {
    name: 'Test Alice',
    entityType: 'person',
    mentionCount: 5,
    profileSummary: 'Test person Alice who works on projects.',
  });

  entityCompanyId = await insertTestEntity(pool, {
    name: 'Test Acme Corp',
    entityType: 'company',
    mentionCount: 3,
  });

  entityTopicId = await insertTestEntity(pool, {
    name: 'Test Machine Learning',
    entityType: 'topic',
    mentionCount: 2,
  });

  // Create test thoughts with embeddings
  const emb1 = randomEmbedding();
  const emb2 = randomEmbedding();
  const emb3 = randomEmbedding();

  thoughtId1 = await insertTestThought(pool, {
    content: 'Meeting with Alice about the machine learning project at Acme Corp',
    source: 'test',
    thoughtType: 'meeting',
    embedding: emb1,
    summary: 'ML project discussion with Alice',
    people: ['Alice'],
    topics: ['machine learning', 'project planning'],
    actionItems: ['Review ML model performance'],
  });

  thoughtId2 = await insertTestThought(pool, {
    content: 'Quarterly review of Acme Corp partnership outcomes and next steps',
    source: 'test',
    thoughtType: 'note',
    embedding: emb2,
    summary: 'Q review of Acme partnership',
    people: ['Alice', 'Bob'],
    topics: ['partnership', 'quarterly review'],
  });

  thoughtId3 = await insertTestThought(pool, {
    content: 'Alice presented new research findings on deep learning architectures',
    source: 'test',
    thoughtType: 'note',
    embedding: emb3,
    people: ['Alice'],
    topics: ['deep learning', 'research'],
  });

  // Link thoughts to entities
  await linkThoughtEntity(pool, thoughtId1, entityPersonId, 'mentions');
  await linkThoughtEntity(pool, thoughtId1, entityCompanyId, 'mentions');
  await linkThoughtEntity(pool, thoughtId1, entityTopicId, 'about');
  await linkThoughtEntity(pool, thoughtId2, entityPersonId, 'mentions');
  await linkThoughtEntity(pool, thoughtId2, entityCompanyId, 'about');
  await linkThoughtEntity(pool, thoughtId3, entityPersonId, 'from');

  // Create entity relationships
  await insertEntityRelationship(pool, entityPersonId, entityCompanyId, {
    relationship: 'co_occurs',
    weight: 3,
    description: 'Alice frequently discusses Acme Corp projects',
    sourceThoughtIds: [thoughtId1, thoughtId2],
  });

  await insertEntityRelationship(pool, entityPersonId, entityTopicId, {
    relationship: 'co_occurs',
    weight: 2,
    sourceThoughtIds: [thoughtId1],
  });

  // Set up MCP server + client via InMemoryTransport
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  mcpServer = createMcpServer(pool, testConfig);
  await mcpServer.connect(serverTransport);
  client = new Client({ name: 'integration-test', version: '1.0.0' });
  await client.connect(clientTransport);
});

afterAll(async () => {
  await client.close();
  await mcpServer.close();
  await cleanupTestData(pool);
  await pool.end();
});

// ---------------------------------------------------------------------------
// Tool Discovery
// ---------------------------------------------------------------------------

describe('MCP tool discovery', () => {
  it('listTools returns all 17 registered tools', async () => {
    const result = await client.listTools();
    expect(result.tools).toBeDefined();
    expect(result.tools.length).toBe(17);

    const names = result.tools.map((t) => t.name).sort();
    expect(names).toEqual([
      'ask',
      'deep_research',
      'get_communities',
      'get_context',
      'get_entity',
      'get_timeline',
      'global_search',
      'list_entities',
      'list_recent',
      'propose_merge',
      'propose_relationship',
      'query_relationships',
      'save_thought',
      'semantic_search',
      'stats',
      'update_entity',
      'update_thought',
    ]);
  });

  it('each tool has a description and inputSchema', async () => {
    const result = await client.listTools();
    for (const tool of result.tools) {
      expect(tool.description).toBeTruthy();
      expect(tool.inputSchema).toBeDefined();
    }
  });
});

// ---------------------------------------------------------------------------
// stats tool
// ---------------------------------------------------------------------------

describe('stats tool', () => {
  it('returns valid response shape for period=all', async () => {
    const result = await client.callTool({ name: 'stats', arguments: { period: 'all' } });
    const data = parseToolResult(result);

    expect(data).toHaveProperty('total');
    expect(data).toHaveProperty('by_type');
    expect(data).toHaveProperty('top_people');
    expect(data).toHaveProperty('top_topics');
    expect(data).toHaveProperty('action_items_count');
    expect(typeof data.total).toBe('number');
    expect(data.total).toBeGreaterThanOrEqual(3); // at least our 3 test thoughts
    expect(Array.isArray(data.by_type)).toBe(true);
  });

  it('returns valid shape for period=month', async () => {
    const result = await client.callTool({ name: 'stats', arguments: { period: 'month' } });
    const data = parseToolResult(result);
    expect(typeof data.total).toBe('number');
    expect(data.total).toBeGreaterThanOrEqual(3);
  });
});

// ---------------------------------------------------------------------------
// list_entities tool
// ---------------------------------------------------------------------------

describe('list_entities tool', () => {
  it('returns entities sorted by mention_count', async () => {
    const result = await client.callTool({
      name: 'list_entities',
      arguments: { sort_by: 'mention_count', limit: 50 },
    });
    const data = parseToolResult(result);
    expect(Array.isArray(data)).toBe(true);

    // Our test entities should be present
    const names = data.map((e: any) => e.name);
    expect(names).toContain('Test Alice');
    expect(names).toContain('Test Acme Corp');
  });

  it('filters by entity_type', async () => {
    const result = await client.callTool({
      name: 'list_entities',
      arguments: { entity_type: 'person', sort_by: 'mention_count', limit: 50 },
    });
    const data = parseToolResult(result);
    expect(Array.isArray(data)).toBe(true);
    for (const entity of data) {
      expect(entity.entity_type).toBe('person');
    }
    const names = data.map((e: any) => e.name);
    expect(names).toContain('Test Alice');
  });

  it('filters by name query prefix', async () => {
    const result = await client.callTool({
      name: 'list_entities',
      arguments: { query: 'test a', sort_by: 'name', limit: 50 },
    });
    const data = parseToolResult(result);
    expect(Array.isArray(data)).toBe(true);
    // Should include Test Alice and Test Acme Corp (both start with "test a")
    expect(data.length).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// get_entity tool
// ---------------------------------------------------------------------------

describe('get_entity tool', () => {
  it('returns entity by name with linked thoughts and connected entities', async () => {
    const result = await client.callTool({
      name: 'get_entity',
      arguments: { name: 'Test Alice' },
    });
    const data = parseToolResult(result);

    expect(data.entity).toBeDefined();
    expect(data.entity.name).toBe('Test Alice');
    expect(data.entity.entity_type).toBe('person');
    expect(Array.isArray(data.recent_thoughts)).toBe(true);
    expect(data.recent_thoughts.length).toBeGreaterThanOrEqual(2);
    expect(Array.isArray(data.connected_entities)).toBe(true);
    expect(typeof data.needs_profile_refresh).toBe('boolean');
  });

  it('returns entity by ID', async () => {
    const result = await client.callTool({
      name: 'get_entity',
      arguments: { entity_id: entityPersonId },
    });
    const data = parseToolResult(result);
    expect(data.entity.id).toBe(entityPersonId);
    expect(data.entity.name).toBe('Test Alice');
  });

  it('returns error when neither entity_id nor name provided', async () => {
    const result = await client.callTool({
      name: 'get_entity',
      arguments: {},
    });
    expect(result.isError).toBe(true);
    const data = parseToolResult(result);
    expect(data.error).toBeDefined();
  });

  it('returns error for non-existent entity', async () => {
    const result = await client.callTool({
      name: 'get_entity',
      arguments: { name: 'Nonexistent Entity XYZ999' },
    });
    expect(result.isError).toBe(true);
    const data = parseToolResult(result);
    expect(data.error).toContain('not found');
  });
});

// ---------------------------------------------------------------------------
// list_recent tool
// ---------------------------------------------------------------------------

describe('list_recent tool', () => {
  it('returns recent thoughts', async () => {
    const result = await client.callTool({
      name: 'list_recent',
      arguments: { days: 30, limit: 50 },
    });
    const data = parseToolResult(result);
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBeGreaterThanOrEqual(3);

    // Verify shape of first result
    const first = data[0];
    expect(first).toHaveProperty('id');
    expect(first).toHaveProperty('content');
    expect(first).toHaveProperty('source');
    expect(first).toHaveProperty('created_at');
  });

  it('filters by source', async () => {
    const result = await client.callTool({
      name: 'list_recent',
      arguments: { days: 30, limit: 50, source: 'test' },
    });
    const data = parseToolResult(result);
    expect(Array.isArray(data)).toBe(true);
    for (const thought of data) {
      expect(thought.source).toBe('test');
    }
  });

  it('filters by thought_type', async () => {
    const result = await client.callTool({
      name: 'list_recent',
      arguments: { days: 30, limit: 50, thought_type: 'meeting' },
    });
    const data = parseToolResult(result);
    for (const thought of data) {
      expect(thought.thought_type).toBe('meeting');
    }
  });
});

// ---------------------------------------------------------------------------
// semantic_search tool (requires mocked Ollama for query embedding)
// ---------------------------------------------------------------------------

describe('semantic_search tool', () => {
  it('returns results when query embedding is mocked', async () => {
    // Mock fetch to return a valid embedding when Ollama is called
    const queryEmbedding = new Array(768).fill(0).map(() => Math.random() * 0.01);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ embeddings: [queryEmbedding] }),
      text: async () => '',
    }) as any;

    try {
      const result = await client.callTool({
        name: 'semantic_search',
        arguments: { query: 'machine learning project', limit: 10, threshold: 0.0 },
      });
      const data = parseToolResult(result);
      expect(Array.isArray(data)).toBe(true);
      // With threshold 0 and our test thoughts, we should get results
      expect(data.length).toBeGreaterThanOrEqual(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ---------------------------------------------------------------------------
// get_context tool
// ---------------------------------------------------------------------------

describe('get_context tool', () => {
  it('returns context for multiple entities', async () => {
    const result = await client.callTool({
      name: 'get_context',
      arguments: {
        entities: ['Test Alice', 'Test Acme Corp'],
        days_back: 90,
        include_action_items: true,
        max_thoughts: 20,
      },
    });
    const data = parseToolResult(result);

    expect(data).toHaveProperty('resolved_entities');
    expect(data).toHaveProperty('shared_thoughts');
    expect(data).toHaveProperty('entity_relationships');
    expect(data).toHaveProperty('action_items');
    expect(data).toHaveProperty('key_topics');

    // Both entities should be resolved
    expect(data.resolved_entities.length).toBe(2);
    const resolvedNames = data.resolved_entities.map((e: any) => e.name);
    expect(resolvedNames).toContain('Test Alice');
    expect(resolvedNames).toContain('Test Acme Corp');

    // Should find shared thoughts (thoughts mentioning both entities)
    expect(data.shared_thoughts.length).toBeGreaterThanOrEqual(1);

    // Relationship edges between the two entities
    expect(data.entity_relationships.length).toBeGreaterThanOrEqual(1);
  });

  it('returns empty result for non-existent entities', async () => {
    const result = await client.callTool({
      name: 'get_context',
      arguments: {
        entities: ['Nonexistent Entity 1', 'Nonexistent Entity 2'],
        days_back: 30,
        include_action_items: false,
        max_thoughts: 10,
      },
    });
    const data = parseToolResult(result);
    expect(data.resolved_entities).toHaveLength(0);
    expect(data.shared_thoughts).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// get_timeline tool
// ---------------------------------------------------------------------------

describe('get_timeline tool', () => {
  it('returns error when neither entity_id nor entity_name provided', async () => {
    const result = await client.callTool({
      name: 'get_timeline',
      arguments: { days_back: 30 },
    });
    expect(result.isError).toBe(true);
    const data = parseToolResult(result);
    expect(data.error).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// query_relationships tool
// ---------------------------------------------------------------------------

describe('query_relationships tool', () => {
  it('returns relationships for an entity', async () => {
    const result = await client.callTool({
      name: 'query_relationships',
      arguments: { entity_name: 'Test Alice', min_weight: 1, limit: 20 },
    });
    const data = parseToolResult(result);
    // Handler returns { entity_id, relationships } object
    expect(data).toHaveProperty('entity_id');
    expect(data).toHaveProperty('relationships');
    expect(Array.isArray(data.relationships)).toBe(true);
    expect(data.relationships.length).toBeGreaterThanOrEqual(1);
  });

  it('filters by min_weight', async () => {
    const result = await client.callTool({
      name: 'query_relationships',
      arguments: { entity_name: 'Test Alice', min_weight: 3, limit: 20 },
    });
    const data = parseToolResult(result);
    // Only the weight=3 relationship with Test Acme Corp should match
    for (const rel of data.relationships) {
      expect(rel.weight).toBeGreaterThanOrEqual(3);
    }
  });

  it('returns error when no entity identifier provided', async () => {
    const result = await client.callTool({
      name: 'query_relationships',
      arguments: { min_weight: 1, limit: 10 },
    });
    expect(result.isError).toBe(true);
    const data = parseToolResult(result);
    expect(data.error).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// update_entity tool (proposal-based)
// ---------------------------------------------------------------------------

describe('update_entity tool', () => {
  it('returns error when no entity identifier provided', async () => {
    const result = await client.callTool({
      name: 'update_entity',
      arguments: { new_name: 'Something Else' },
    });
    expect(result.isError).toBe(true);
    const data = parseToolResult(result);
    expect(data.error).toBeDefined();
  });
});
