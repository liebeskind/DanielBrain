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
  queryRelationshipsInputSchema,
  updateThoughtInputSchema,
  proposeRelationshipInputSchema,
  getCommunitiesInputSchema,
  globalSearchInputSchema,
  updateEntityInputSchema,
  proposeMergeInputSchema,
  askInputSchema,
  deepResearchInputSchema,
} from '@danielbrain/shared';
import { handleSemanticSearch } from './tools/semantic-search.js';
import { handleListRecent } from './tools/list-recent.js';
import { handleStats } from './tools/stats.js';
import { handleSaveThought } from './tools/save-thought.js';
import { handleGetEntity } from './tools/get-entity.js';
import { handleListEntities } from './tools/list-entities.js';
import { handleGetContext } from './tools/get-context.js';
import { handleGetTimeline } from './tools/get-timeline.js';
import { handleQueryRelationships } from './tools/query-relationships.js';
import { handleUpdateThought } from './tools/update-thought.js';
import { handleProposeRelationship } from './tools/propose-relationship.js';
import { handleGetCommunities } from './tools/get-communities.js';
import { handleGlobalSearch } from './tools/global-search.js';
import { handleUpdateEntity } from './tools/update-entity.js';
import { handleProposeMerge } from './tools/propose-merge.js';
import { handleAsk } from './tools/ask.js';
import { handleDeepResearch } from './tools/deep-research.js';
import type { Config } from '../config.js';

export function createMcpServer(pool: pg.Pool, config: Config): McpServer {
  const server = new McpServer({
    name: 'DanielBrain',
    version: '0.3.0',
  });

  // ==========================================================================
  // CONSOLIDATED TOOLS (start here if unsure which tool to use)
  // ==========================================================================

  server.tool(
    'ask',
    `PURPOSE: Answer any question by searching thoughts, entities, and communities in parallel.
USE WHEN: You have a question and aren't sure which specific tool to use, or you want comprehensive results from all data sources at once.
NOT FOR: Writing data (use save_thought), modifying entities (use update_entity), or deep multi-step research (use deep_research).
EXAMPLE: ask({ query: "What do we know about the Stride partnership?", limit: 10 })`,
    {
      query: askInputSchema.shape.query,
      days_back: askInputSchema.shape.days_back,
      limit: askInputSchema.shape.limit,
    },
    async (params) => {
      const input = askInputSchema.parse(params);
      const result = await handleAsk(input, pool, config);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    'deep_research',
    `PURPOSE: Answer complex questions by decomposing into sub-questions, searching each, and optionally synthesizing a combined answer.
USE WHEN: The question requires connecting multiple pieces of information, or a simple search wouldn't be sufficient (e.g., "How has our product strategy evolved over the last quarter?").
NOT FOR: Simple factual lookups (use ask or semantic_search). Costs 2 LLM calls when synthesize=true.
EXAMPLE: deep_research({ question: "What are the key decisions made about the K12 Zone product?", synthesize: true })`,
    {
      question: deepResearchInputSchema.shape.question,
      max_iterations: deepResearchInputSchema.shape.max_iterations,
      include_community_context: deepResearchInputSchema.shape.include_community_context,
      synthesize: deepResearchInputSchema.shape.synthesize,
    },
    async (params) => {
      const input = deepResearchInputSchema.parse(params);
      const result = await handleDeepResearch(input, pool, config);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        isError: 'error' in result,
      };
    }
  );

  // ==========================================================================
  // THOUGHT TOOLS (search, browse, save, update)
  // ==========================================================================

  server.tool(
    'semantic_search',
    `PURPOSE: Search thoughts by meaning using hybrid vector + full-text search.
USE WHEN: Looking for specific facts, discussions, or notes. Supports filters by type, person, topic, source, and time range.
NOT FOR: Broad thematic questions (use global_search), entity profiles (use get_entity), or meeting prep (use get_context). If unsure which tool to use, call ask instead.
EXAMPLE: semantic_search({ query: "budget planning for Q2", person: "Chris", days_back: 30 })`,
    {
      query: semanticSearchInputSchema.shape.query,
      limit: semanticSearchInputSchema.shape.limit,
      threshold: semanticSearchInputSchema.shape.threshold,
      thought_type: semanticSearchInputSchema.shape.thought_type,
      person: semanticSearchInputSchema.shape.person,
      topic: semanticSearchInputSchema.shape.topic,
      days_back: semanticSearchInputSchema.shape.days_back,
      source: semanticSearchInputSchema.shape.source,
      sources: semanticSearchInputSchema.shape.sources,
    },
    async (params) => {
      const input = semanticSearchInputSchema.parse(params);
      const results = await handleSemanticSearch(input, pool, config);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(results, null, 2) }],
      };
    }
  );

  server.tool(
    'list_recent',
    `PURPOSE: Browse recently captured thoughts, ordered by date.
USE WHEN: You want to see what's new, review recent activity, or check what was captured from a specific source.
NOT FOR: Searching by meaning (use semantic_search) or finding specific topics (use ask).
EXAMPLE: list_recent({ days: 7, source: "fathom", limit: 10 })`,
    {
      days: listRecentInputSchema.shape.days,
      limit: listRecentInputSchema.shape.limit,
      thought_type: listRecentInputSchema.shape.thought_type,
      source: listRecentInputSchema.shape.source,
    },
    async (params) => {
      const input = listRecentInputSchema.parse(params);
      const results = await handleListRecent(input, pool);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(results, null, 2) }],
      };
    }
  );

  server.tool(
    'stats',
    `PURPOSE: Get aggregate statistics — counts, breakdowns by type, top people, top topics, action item counts.
USE WHEN: You need an overview of what's in the knowledge base, or want to understand volume and distribution.
NOT FOR: Searching content (use semantic_search or ask).
EXAMPLE: stats({ period: "month" })`,
    {
      period: statsInputSchema.shape.period,
    },
    async (params) => {
      const input = statsInputSchema.parse(params);
      const results = await handleStats(input, pool);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(results, null, 2) }],
      };
    }
  );

  server.tool(
    'save_thought',
    `PURPOSE: Save a new thought into the knowledge base. Triggers the full processing pipeline: embedding, metadata extraction, entity resolution, and chunking for long content.
USE WHEN: You want to record a note, insight, meeting summary, or any information for future retrieval.
NOT FOR: Searching or reading (use semantic_search, ask, or list_recent).
EXAMPLE: save_thought({ content: "Met with Chris about K12 Zone roadmap. Key decision: launch beta in April.", source: "mcp" })`,
    {
      content: saveThoughtInputSchema.shape.content,
      source: saveThoughtInputSchema.shape.source,
    },
    async (params) => {
      const input = saveThoughtInputSchema.parse(params);
      const result = await handleSaveThought(input, pool, config);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    'update_thought',
    `PURPOSE: Correct or update metadata on an existing thought (PATCH semantics — only updates fields you provide).
USE WHEN: The extraction pipeline got something wrong — wrong people, topics, summary, or thought_type — and you want to fix it.
NOT FOR: Adding new thoughts (use save_thought) or updating entities (use update_entity).
EXAMPLE: update_thought({ thought_id: "uuid-here", people: ["Chris Psiaki", "Daniel"], topics: ["K12 Zone"] })`,
    {
      thought_id: updateThoughtInputSchema.shape.thought_id,
      summary: updateThoughtInputSchema.shape.summary,
      action_items: updateThoughtInputSchema.shape.action_items,
      people: updateThoughtInputSchema.shape.people,
      topics: updateThoughtInputSchema.shape.topics,
      thought_type: updateThoughtInputSchema.shape.thought_type,
      sentiment: updateThoughtInputSchema.shape.sentiment,
    },
    async (params) => {
      const input = updateThoughtInputSchema.parse(params);
      const result = await handleUpdateThought(input, pool);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        isError: 'error' in result,
      };
    }
  );

  // ==========================================================================
  // ENTITY TOOLS (lookup, browse, update, merge)
  // ==========================================================================

  server.tool(
    'get_entity',
    `PURPOSE: Deep dive on a single entity — full profile, recent linked thoughts, connected entities, and relationship edges.
USE WHEN: You know which entity you want and need comprehensive information about it. Lookup by UUID or name.
NOT FOR: Browsing or discovering entities (use list_entities), or getting context across multiple entities (use get_context). If unsure which tool to use, call ask instead.
EXAMPLE: get_entity({ name: "Chris Psiaki" })`,
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
    `PURPOSE: Browse or search the entity catalog. Filter by type, search by name prefix, sort by mentions/recency/name.
USE WHEN: You want to discover what entities exist, find entities matching a pattern, or see the most active/recent entities.
NOT FOR: Deep dive on one entity (use get_entity), or semantic search over thoughts (use semantic_search). If unsure which tool to use, call ask instead.
EXAMPLE: list_entities({ entity_type: "person", sort_by: "mention_count", limit: 10 })`,
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
    `PURPOSE: Assemble a briefing from the intersection of multiple entities — ideal for meeting prep.
USE WHEN: You need context about the relationship between 2-5 specific entities (e.g., "prep me for meeting with Alice about Project X"). Requires exact entity names.
NOT FOR: Free-form questions (use ask or semantic_search), or single entity lookup (use get_entity).
EXAMPLE: get_context({ entities: ["Chris Psiaki", "K12 Zone"], days_back: 30 })`,
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
    `PURPOSE: Chronological timeline of thoughts linked to an entity, grouped by date.
USE WHEN: You want to see how an entity's story unfolds over time, or review activity from specific sources.
NOT FOR: Searching by meaning (use semantic_search) or entity profiles (use get_entity). If unsure which tool to use, call ask instead.
EXAMPLE: get_timeline({ entity_name: "Topia", days_back: 60, sources: ["fathom"] })`,
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

  server.tool(
    'update_entity',
    `PURPOSE: Update an entity's name, aliases, type, or metadata. All changes go through the approvals queue for human review.
USE WHEN: An entity has the wrong name, is missing aliases, needs metadata added, or has the wrong type.
NOT FOR: Merging duplicate entities (use propose_merge), or updating thought metadata (use update_thought).
EXAMPLE: update_entity({ name: "Chris", new_name: "Chris Psiaki", add_aliases: ["christopher"] })`,
    {
      entity_id: updateEntityInputSchema.shape.entity_id,
      name: updateEntityInputSchema.shape.name,
      new_name: updateEntityInputSchema.shape.new_name,
      add_aliases: updateEntityInputSchema.shape.add_aliases,
      remove_aliases: updateEntityInputSchema.shape.remove_aliases,
      metadata: updateEntityInputSchema.shape.metadata,
      entity_type: updateEntityInputSchema.shape.entity_type,
    },
    async (params) => {
      const input = updateEntityInputSchema.parse(params);
      if (!input.entity_id && !input.name) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Either entity_id or name must be provided' }) }],
          isError: true,
        };
      }
      const result = await handleUpdateEntity(input, pool);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        isError: 'error' in result,
      };
    }
  );

  server.tool(
    'propose_merge',
    `PURPOSE: Propose merging two duplicate entities. The "loser" entity is absorbed into the "winner". Goes through the approvals queue.
USE WHEN: You've found two entities that represent the same real-world thing (e.g., "Chris" and "Chris Psiaki").
NOT FOR: Updating entity fields (use update_entity), or creating relationships (use propose_relationship).
EXAMPLE: propose_merge({ winner: "Chris Psiaki", loser: "Chris", reason: "Same person — CTO of Topia" })`,
    {
      winner: proposeMergeInputSchema.shape.winner,
      loser: proposeMergeInputSchema.shape.loser,
      reason: proposeMergeInputSchema.shape.reason,
    },
    async (params) => {
      const input = proposeMergeInputSchema.parse(params);
      const result = await handleProposeMerge(input, pool);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        isError: 'error' in result,
      };
    }
  );

  // ==========================================================================
  // RELATIONSHIP TOOLS
  // ==========================================================================

  server.tool(
    'query_relationships',
    `PURPOSE: Query entity-to-entity relationship edges. Returns co-occurrence weights, LLM-generated descriptions, and connected entity info.
USE WHEN: You want to understand how two or more entities relate, or see the strongest connections for a given entity.
NOT FOR: Entity profiles (use get_entity), or meeting prep (use get_context). If unsure which tool to use, call ask instead.
EXAMPLE: query_relationships({ entity_name: "Topia", min_weight: 3, limit: 10 })`,
    {
      entity_name: z.string().min(1).optional().describe('Entity name to search for'),
      entity_id: z.string().uuid().optional().describe('UUID of the entity'),
      min_weight: z.number().int().min(1).default(1).describe('Minimum co-occurrence weight'),
      limit: z.number().int().min(1).max(100).default(20).describe('Max edges to return'),
    },
    async (params) => {
      if (!params.entity_id && !params.entity_name) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Either entity_id or entity_name must be provided' }) }],
          isError: true,
        };
      }
      const input = queryRelationshipsInputSchema.parse(params);
      const result = await handleQueryRelationships(input, pool);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    'propose_relationship',
    `PURPOSE: Propose a new typed relationship between two entities. Creates a proposal for human review.
USE WHEN: You've identified a relationship between entities that isn't captured by co-occurrence (e.g., "Alice reports to Bob").
NOT FOR: Merging duplicates (use propose_merge), or querying existing relationships (use query_relationships).
EXAMPLE: propose_relationship({ source_entity: "Chris Psiaki", target_entity: "Topia", description: "CTO of Topia", relationship_type: "role_at" })`,
    {
      source_entity: proposeRelationshipInputSchema.shape.source_entity,
      target_entity: proposeRelationshipInputSchema.shape.target_entity,
      description: proposeRelationshipInputSchema.shape.description,
      relationship_type: proposeRelationshipInputSchema.shape.relationship_type,
    },
    async (params) => {
      const input = proposeRelationshipInputSchema.parse(params);
      const result = await handleProposeRelationship(input, pool);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        isError: 'error' in result,
      };
    }
  );

  // ==========================================================================
  // COMMUNITY TOOLS (clusters, themes, global search)
  // ==========================================================================

  server.tool(
    'get_communities',
    `PURPOSE: List detected communities — clusters of entities that frequently co-occur.
USE WHEN: You want to understand the structure of the knowledge graph, see which entities cluster together, or find a community by entity membership.
NOT FOR: Searching by theme (use global_search), or entity details (use get_entity). If unsure which tool to use, call ask instead.
EXAMPLE: get_communities({ entity_id: "uuid-here", limit: 5 })`,
    {
      level: getCommunitiesInputSchema.shape.level,
      entity_id: getCommunitiesInputSchema.shape.entity_id,
      search: getCommunitiesInputSchema.shape.search,
      limit: getCommunitiesInputSchema.shape.limit,
    },
    async (params) => {
      const input = getCommunitiesInputSchema.parse(params);
      const results = await handleGetCommunities(input, pool);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(results, null, 2) }],
      };
    }
  );

  server.tool(
    'global_search',
    `PURPOSE: Search across community-level summaries for broad, thematic questions.
USE WHEN: The question is about high-level themes, organizational patterns, or "what is the team working on?" — things that span many thoughts and entities.
NOT FOR: Specific facts or individual discussions (use semantic_search), or entity profiles (use get_entity). If unsure which tool to use, call ask instead.
EXAMPLE: global_search({ query: "What are the main strategic initiatives?" })`,
    {
      query: globalSearchInputSchema.shape.query,
      level: globalSearchInputSchema.shape.level,
      limit: globalSearchInputSchema.shape.limit,
    },
    async (params) => {
      const input = globalSearchInputSchema.parse(params);
      const results = await handleGlobalSearch(input, pool, config);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(results, null, 2) }],
      };
    }
  );

  return server;
}
