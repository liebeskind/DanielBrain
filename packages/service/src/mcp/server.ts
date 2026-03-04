import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type pg from 'pg';
import {
  semanticSearchInputSchema,
  listRecentInputSchema,
  statsInputSchema,
  saveThoughtInputSchema,
  listEntitiesInputSchema,
  getContextInputSchema,
} from '@danielbrain/shared';
import { handleSemanticSearch } from './tools/semantic-search.js';
import { handleListRecent } from './tools/list-recent.js';
import { handleStats } from './tools/stats.js';
import { handleSaveThought } from './tools/save-thought.js';
import { handleGetEntity } from './tools/get-entity.js';
import { handleListEntities } from './tools/list-entities.js';
import { handleGetContext } from './tools/get-context.js';
import { handleGetTimeline } from './tools/get-timeline.js';
import type { Config } from '../config.js';

export function createMcpServer(pool: pg.Pool, config: Config): McpServer {
  const server = new McpServer({
    name: 'DanielBrain',
    version: '0.2.0',
  });

  server.tool(
    'semantic_search',
    'Search thoughts by semantic similarity. Use this to find relevant past thoughts, ideas, meeting notes, etc.',
    {
      query: semanticSearchInputSchema.shape.query,
      limit: semanticSearchInputSchema.shape.limit,
      threshold: semanticSearchInputSchema.shape.threshold,
      thought_type: semanticSearchInputSchema.shape.thought_type,
      person: semanticSearchInputSchema.shape.person,
      topic: semanticSearchInputSchema.shape.topic,
      days_back: semanticSearchInputSchema.shape.days_back,
    },
    async (params) => {
      const input = semanticSearchInputSchema.parse(params);
      const results = await handleSemanticSearch(input, pool, config);
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(results, null, 2),
          },
        ],
      };
    }
  );

  server.tool(
    'list_recent',
    'List recent thoughts, ordered by date. Useful for seeing what was captured recently.',
    {
      days: listRecentInputSchema.shape.days,
      limit: listRecentInputSchema.shape.limit,
      thought_type: listRecentInputSchema.shape.thought_type,
    },
    async (params) => {
      const input = listRecentInputSchema.parse(params);
      const results = await handleListRecent(input, pool);
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(results, null, 2),
          },
        ],
      };
    }
  );

  server.tool(
    'stats',
    'Get statistics about stored thoughts: counts, breakdowns by type, top people, top topics.',
    {
      period: statsInputSchema.shape.period,
    },
    async (params) => {
      const input = statsInputSchema.parse(params);
      const results = await handleStats(input, pool);
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(results, null, 2),
          },
        ],
      };
    }
  );

  server.tool(
    'save_thought',
    'Save a new thought. Processes it through the pipeline: embedding, metadata extraction, and optional chunking for long content.',
    {
      content: saveThoughtInputSchema.shape.content,
      source: saveThoughtInputSchema.shape.source,
    },
    async (params) => {
      const input = saveThoughtInputSchema.parse(params);
      const result = await handleSaveThought(input, pool, config);
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }
  );

  // --- Entity tools ---

  server.tool(
    'get_entity',
    'Get full profile for an entity (person, company, project, etc). Returns entity details, recent linked thoughts, and connected entities. Lookup by ID or name.',
    {
      entity_id: z.string().uuid().optional().describe('UUID of the entity'),
      name: z.string().min(1).optional().describe('Name to search for'),
      entity_type: z.enum(['person', 'company', 'topic', 'product', 'project', 'place']).optional().describe('Filter by entity type'),
    },
    async (params) => {
      if (!params.entity_id && !params.name) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Either entity_id or name must be provided' }) }],
          isError: true,
        };
      }
      try {
        const result = await handleGetEntity(params, pool, config);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (err: any) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: err.message }) }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    'list_entities',
    'Browse or search known entities. Filter by type, search by name prefix, sort by mention count, recency, or name.',
    {
      entity_type: listEntitiesInputSchema.shape.entity_type,
      query: listEntitiesInputSchema.shape.query,
      sort_by: listEntitiesInputSchema.shape.sort_by,
      limit: listEntitiesInputSchema.shape.limit,
    },
    async (params) => {
      const input = listEntitiesInputSchema.parse(params);
      const results = await handleListEntities(input, pool);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(results, null, 2) }],
      };
    }
  );

  server.tool(
    'get_context',
    'Assemble a briefing from the intersection of multiple entities. Great for meeting prep — e.g., "give me context for my meeting with Alice about Project X". Returns shared thoughts ranked by entity overlap, action items, and key topics.',
    {
      entities: getContextInputSchema.shape.entities,
      days_back: getContextInputSchema.shape.days_back,
      include_action_items: getContextInputSchema.shape.include_action_items,
      max_thoughts: getContextInputSchema.shape.max_thoughts,
    },
    async (params) => {
      const input = getContextInputSchema.parse(params);
      const result = await handleGetContext(input, pool);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    'get_timeline',
    'Get a chronological timeline of thoughts related to an entity, grouped by date. Filter by source (slack, telegram, mcp, etc).',
    {
      entity_id: z.string().uuid().optional().describe('UUID of the entity'),
      entity_name: z.string().min(1).optional().describe('Name to search for'),
      days_back: z.number().int().min(1).default(30).describe('How many days back to look'),
      limit: z.number().int().min(1).max(100).default(50).describe('Max entries to return'),
      sources: z.array(z.string()).optional().describe('Filter by source (e.g., ["slack", "telegram"])'),
    },
    async (params) => {
      if (!params.entity_id && !params.entity_name) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Either entity_id or entity_name must be provided' }) }],
          isError: true,
        };
      }
      try {
        const result = await handleGetTimeline(params as any, pool);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (err: any) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: err.message }) }],
          isError: true,
        };
      }
    }
  );

  return server;
}
