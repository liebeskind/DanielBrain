import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type pg from 'pg';
import {
  semanticSearchInputSchema,
  listRecentInputSchema,
  statsInputSchema,
  saveThoughtInputSchema,
} from '@danielbrain/shared';
import { handleSemanticSearch } from './tools/semantic-search.js';
import { handleListRecent } from './tools/list-recent.js';
import { handleStats } from './tools/stats.js';
import { handleSaveThought } from './tools/save-thought.js';
import type { Config } from '../config.js';

export function createMcpServer(pool: pg.Pool, config: Config): McpServer {
  const server = new McpServer({
    name: 'DanielBrain',
    version: '0.1.0',
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

  return server;
}
