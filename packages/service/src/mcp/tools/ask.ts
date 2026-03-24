import type pg from 'pg';
import { handleSemanticSearch } from './semantic-search.js';
import { extractKeywords } from '../../processor/keyword-extractor.js';
import { detectIntent } from '../../processor/intent-detector.js';
import { searchFacts } from '../../db/fact-queries.js';
import { CHAT_CONTEXT_ENTITY_RELATIONSHIP_LIMIT } from '@danielbrain/shared';

interface AskInput {
  query: string;
  days_back?: number;
  limit: number;
}

interface AskConfig {
  ollamaBaseUrl: string;
  embeddingModel: string;
  extractionModel: string;
  rerankerModel?: string;
}

export async function handleAsk(
  input: AskInput,
  pool: pg.Pool,
  config: AskConfig,
  visibilityTags?: string[] | null,
) {
  // Step 1: Extract keywords (entities + themes) and get query embedding
  const keywords = await extractKeywords(input.query, pool, config);

  // Step 2: Detect intent (fast-path heuristics + LLM fallback)
  const intent = await detectIntent(input.query, keywords.entities, config);

  // Merge intent adjustments with explicit user params (user always wins)
  const searchQuery = intent.reformulated_query || input.query;
  const searchThreshold = intent.adjustments.threshold ?? 0.2;
  const searchDaysBack = input.days_back ?? intent.adjustments.days_back;
  const searchLimit = input.limit;

  // Step 3: Run semantic search and community member enrichment in parallel
  // Reuse the query embedding from keyword extraction to avoid duplicate Ollama call
  const vectorStr = `[${keywords.queryEmbedding.join(',')}]`;

  const [thoughts, communityResults, entityDetails, factResults] = await Promise.all([
    handleSemanticSearch(
      { query: searchQuery, limit: searchLimit, threshold: searchThreshold, days_back: searchDaysBack },
      pool,
      config,
      visibilityTags,
    ),
    searchCommunitiesWithEmbedding(vectorStr, pool),
    fetchEntityDetails(keywords.entities, pool),
    searchFacts(pool, keywords.queryEmbedding, { limit: 10, threshold: 0.3 }, visibilityTags ?? null),
  ]);

  return {
    query: input.query,
    intent: { type: intent.intent, confidence: intent.confidence, reasoning: intent.reasoning },
    entities: entityDetails,
    thoughts: thoughts.map((t) => ({
      id: t.id,
      content: t.summary || (t.content.length > 500 ? t.content.slice(0, 500) + '...' : t.content),
      thought_type: t.thought_type,
      people: t.people,
      topics: t.topics,
      source: t.source,
      similarity: t.similarity,
      created_at: t.created_at,
    })),
    facts: factResults.map((f) => ({
      statement: f.statement,
      fact_type: f.fact_type,
      confidence: f.confidence,
      similarity: f.similarity,
      subject: f.subject_name,
      object: f.object_name,
    })),
    communities: communityResults,
    themes: keywords.themes,
  };
}

async function searchCommunitiesWithEmbedding(
  vectorStr: string,
  pool: pg.Pool,
) {
  const { rows: communities } = await pool.query(
    `SELECT c.id, c.title, c.summary, c.member_count,
            1 - ((c.embedding::halfvec(768)) <=> ($1::vector::halfvec(768))) as similarity
     FROM communities c
     WHERE c.summary IS NOT NULL AND c.embedding IS NOT NULL
     ORDER BY c.embedding::halfvec(768) <=> $1::vector::halfvec(768)
     LIMIT 3`,
    [vectorStr]
  );

  const results = [];
  for (const community of communities) {
    const { rows: members } = await pool.query(
      `SELECT e.name, e.entity_type
       FROM entity_communities ec
       JOIN entities e ON e.id = ec.entity_id
       WHERE ec.community_id = $1
       ORDER BY e.mention_count DESC
       LIMIT 10`,
      [community.id]
    );

    results.push({
      community_id: community.id,
      title: community.title,
      summary: community.summary,
      similarity: parseFloat(community.similarity),
      members: members.map((m: { name: string; entity_type: string }) => ({
        name: m.name,
        entity_type: m.entity_type,
      })),
    });
  }

  return results;
}

async function fetchEntityDetails(
  entities: Array<{ id: string; name: string; entity_type: string; profile_summary: string | null }>,
  pool: pg.Pool,
) {
  if (entities.length === 0) return [];

  const entityIds = entities.map((e) => e.id);
  const { rows: relationships } = await pool.query(
    `SELECT
       CASE WHEN er.source_id = ANY($1) THEN er.source_id ELSE er.target_id END as entity_id,
       e.name, e.entity_type, er.weight, er.description
     FROM entity_relationships er
     JOIN entities e ON e.id = CASE WHEN er.source_id = ANY($1) THEN er.target_id ELSE er.source_id END
     WHERE (er.source_id = ANY($1) OR er.target_id = ANY($1))
       AND er.invalid_at IS NULL
     ORDER BY er.weight DESC`,
    [entityIds],
  );

  // Group relationships by entity
  const relMap = new Map<string, Array<{ name: string; entity_type: string; weight: number; description: string | null }>>();
  for (const row of relationships) {
    const list = relMap.get(row.entity_id) || [];
    if (list.length < CHAT_CONTEXT_ENTITY_RELATIONSHIP_LIMIT) {
      list.push({ name: row.name, entity_type: row.entity_type, weight: row.weight, description: row.description });
      relMap.set(row.entity_id, list);
    }
  }

  return entities.map((e) => ({
    id: e.id,
    name: e.name,
    entity_type: e.entity_type,
    profile_summary: e.profile_summary,
    connections: relMap.get(e.id) || [],
  }));
}
