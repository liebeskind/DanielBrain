import type pg from 'pg';
import { embed } from './embedder.js';
import { COMMUNITY_SUMMARY_BATCH_SIZE, OLLAMA_LLM_TIMEOUT_MS } from '@danielbrain/shared';

interface SummarizerConfig {
  ollamaBaseUrl: string;
  embeddingModel: string;
  extractionModel: string;
}

export const COMMUNITY_SUMMARY_SYSTEM_PROMPT = `You are analyzing a cluster of related entities in a knowledge graph. This cluster was detected by a community detection algorithm — these entities frequently co-occur in the same context.

Your job is to produce a title, summary, and full report for this group.

OUTPUT FORMAT — Return ONLY valid JSON, no other text:
{
  "title": "3-6 word label for the group",
  "summary": "2-3 sentences capturing what connects these entities and why they form a cluster.",
  "full_report": "Detailed paragraph (4-8 sentences) with specific references to members and their relationships."
}

RULES:
- Be factual — only state what is supported by the provided context.
- Focus on what CONNECTS these entities, not individual descriptions.
- The title should be descriptive and specific, not generic (e.g., "Topia Engineering Leadership" not "Group of People").
- Write the summary and full_report as direct statements of fact. Jump straight into WHO and WHAT.
- Do NOT start summary with "This cluster", "This group", "These entities", or any meta-reference to the cluster itself.
- Do NOT start full_report with the group title or "The [title] cluster/group is/connects...".
- Do NOT start with "Based on" or similar meta-phrases.
- Do NOT include entity types in parentheses in the report text.

EXAMPLE INPUT:
Members: Daniel Liebeskind (person), Chris Psiaki (person), Topia (company), SchoolSpace (product)
Relationships: Daniel↔Topia: CEO, involved in product strategy. Chris↔Topia: CTO and co-founder. Daniel↔Chris: Co-founders working on spatial platform.
Thoughts: Discussion about Q1 roadmap, SchoolSpace launch timeline, engineering hiring.

EXAMPLE OUTPUT:
{"title": "Topia Core Leadership", "summary": "Daniel Liebeskind and Chris Psiaki are co-founders of Topia who work together on product strategy, engineering roadmap, and key initiatives like SchoolSpace.", "full_report": "Daniel Liebeskind serves as CEO of Topia and drives product strategy, while Chris Psiaki serves as CTO and co-founder. They frequently collaborate on engineering roadmap decisions, hiring, and product launches. SchoolSpace is a key product they are actively developing together, with discussions covering launch timelines and Q1 priorities. Their work spans technical architecture, go-to-market planning, and team building."}

BAD EXAMPLES (do NOT do these):
- {"title": "Group 1"} — too generic, no information
- {"title": "Entity Cluster"} — meaningless label
- {"summary": "This cluster connects leaders in..."} — do NOT reference "this cluster/group", just state the facts
- {"summary": "These entities were detected in a cluster by the algorithm."} — meta-description, not content
- {"full_report": "The EdTech Leaders cluster is a network of..."} — do NOT start with the title or "The X cluster/group is"
- {"full_report": "This cluster centers on..."} — do NOT reference the cluster, describe the people and their work directly`;

interface CommunitySummaryResult {
  title: string;
  summary: string;
  full_report: string;
}

export async function summarizeCommunity(
  communityId: string,
  pool: pg.Pool,
  config: SummarizerConfig,
): Promise<CommunitySummaryResult | null> {
  // Fetch member entities
  const { rows: members } = await pool.query(
    `SELECT e.id, e.name, e.entity_type, e.profile_summary
     FROM entity_communities ec
     JOIN entities e ON e.id = ec.entity_id
     WHERE ec.community_id = $1
     ORDER BY e.mention_count DESC`,
    [communityId]
  );

  if (members.length === 0) return null;

  const memberIds = members.map((m: { id: string }) => m.id);

  // Fetch relationships between members
  const { rows: relationships } = await pool.query(
    `SELECT er.description, s.name as source_name, t.name as target_name
     FROM entity_relationships er
     JOIN entities s ON s.id = er.source_id
     JOIN entities t ON t.id = er.target_id
     WHERE er.source_id = ANY($1) AND er.target_id = ANY($1)
       AND er.description IS NOT NULL AND er.invalid_at IS NULL
     ORDER BY er.weight DESC
     LIMIT 20`,
    [memberIds]
  );

  // Fetch recent thought excerpts linked to members
  const { rows: thoughts } = await pool.query(
    `SELECT DISTINCT ON (t.id) t.summary, t.content, t.source, t.created_at
     FROM thought_entities te
     JOIN thoughts t ON t.id = te.thought_id
     WHERE te.entity_id = ANY($1) AND t.parent_id IS NULL
     ORDER BY t.id, t.created_at DESC
     LIMIT 20`,
    [memberIds]
  );

  // Build prompt
  const membersText = members.map((m: { name: string; entity_type: string; profile_summary: string | null }) => {
    const profile = m.profile_summary ? ` — ${m.profile_summary}` : '';
    return `${m.name} (${m.entity_type})${profile}`;
  }).join('\n');

  const relationshipsText = relationships.length > 0
    ? relationships.map((r: { source_name: string; target_name: string; description: string }) =>
        `${r.source_name}↔${r.target_name}: ${r.description}`
      ).join('\n')
    : 'No relationship descriptions available yet.';

  const thoughtsText = thoughts.map((t: { summary: string | null; content: string; source: string }, i: number) => {
    const text = t.summary || t.content.slice(0, 300);
    return `${i + 1}. (${t.source}) ${text}`;
  }).join('\n');

  const prompt = `Members:\n${membersText}\n\nRelationships:\n${relationshipsText}\n\nRecent thoughts:\n${thoughtsText}`;

  const response = await fetch(`${config.ollamaBaseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: config.extractionModel,
      stream: false,
      messages: [
        { role: 'system', content: COMMUNITY_SUMMARY_SYSTEM_PROMPT },
        { role: 'user', content: prompt },
      ],
    }),
    signal: AbortSignal.timeout(OLLAMA_LLM_TIMEOUT_MS),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Ollama community summary failed (${response.status}): ${errorText}`);
  }

  const data = await response.json() as { message: { content: string } };
  const raw = data.message.content.trim();

  // Parse JSON response
  let result: CommunitySummaryResult;
  try {
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON found');
    result = JSON.parse(jsonMatch[0]);
    if (!result.title || !result.summary || !result.full_report) {
      throw new Error('Missing required fields');
    }
  } catch (err) {
    console.error('Failed to parse community summary response:', raw);
    throw new Error(`Failed to parse community summary: ${(err as Error).message}`);
  }

  // Embed the summary
  const summaryEmbedding = await embed(result.summary, config);
  const vectorStr = `[${summaryEmbedding.join(',')}]`;

  // Update community
  await pool.query(
    `UPDATE communities
     SET title = $1, summary = $2, full_report = $3, embedding = $4::vector, updated_at = NOW()
     WHERE id = $5`,
    [result.title, result.summary, result.full_report, vectorStr, communityId]
  );

  return result;
}

export async function summarizeUnsummarizedCommunities(
  pool: pg.Pool,
  config: SummarizerConfig,
): Promise<number> {
  const { rows } = await pool.query(
    `SELECT id FROM communities
     WHERE summary IS NULL
     ORDER BY member_count DESC
     LIMIT $1`,
    [COMMUNITY_SUMMARY_BATCH_SIZE]
  );

  let summarized = 0;
  for (const community of rows) {
    try {
      const result = await summarizeCommunity(community.id, pool, config);
      if (result) summarized++;
    } catch (err) {
      console.error(`Community summary failed for ${community.id}:`, err);
    }
  }

  return summarized;
}
