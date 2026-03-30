import type pg from 'pg';
import { fetchThoughtsForEntity } from '../db/thought-queries.js';
import { DEAL_SYNTHESIS_BATCH_SIZE, DEAL_SYNTHESIS_STALE_DAYS, OLLAMA_LLM_TIMEOUT_MS } from '@danielbrain/shared';
import { isChatActive } from '../ollama-mutex.js';
import { createChildLogger } from '../logger.js';

const log = createChildLogger('deal-synthesizer');

interface SynthesizerConfig {
  ollamaBaseUrl: string;
  extractionModel: string;
}

interface DealSynthesis {
  summary: string;
  key_facts: {
    student_count?: string;
    timeline?: string;
    contacts?: string[];
    interest?: string;
    requirements?: string;
    next_steps?: string;
    risks?: string;
  };
  call_history: Array<{ date: string; summary: string; source: string }>;
  sources: string[];
  source_count: number;
  synthesized_at: string;
}

const DEAL_SYNTHESIS_PROMPT = `You are synthesizing all available information about a sales deal. You have the deal record and related meeting transcripts, notes, and calls.

OUTPUT FORMAT — Return ONLY valid JSON, no other text:
{
  "summary": "3-5 sentence overview of the deal: who they are, what they want, where things stand, and what's next.",
  "key_facts": {
    "student_count": "Number of students or users if mentioned, otherwise null",
    "timeline": "Deal timeline, key dates, expected close date",
    "contacts": ["Name1", "Name2"],
    "interest": "What features/products they're interested in",
    "requirements": "Their specific requirements or concerns",
    "next_steps": "Agreed next steps or pending actions",
    "risks": "Any risks or blockers mentioned"
  },
  "call_history": [
    {"date": "YYYY-MM-DD", "summary": "1-2 sentence summary of what was discussed", "source": "fathom or hubspot"}
  ]
}

RULES:
- ONLY include facts from the provided context. Do NOT invent details.
- If a field has no information, set it to null (for strings) or [] (for arrays).
- For call_history, include every distinct meeting or call found in the context, in chronological order.
- Focus on SUBSTANCE: what was discussed, decided, or agreed — not who attended.
- Be specific with names, numbers, dates, and product features when available.`;

/** Synthesize a single deal by gathering all related thoughts for its company */
export async function synthesizeDeal(
  dealThoughtId: string,
  pool: pg.Pool,
  config: SynthesizerConfig,
): Promise<DealSynthesis | null> {
  // Load the deal thought
  const { rows: [deal] } = await pool.query(
    `SELECT id, content, source_meta FROM thoughts WHERE id = $1`,
    [dealThoughtId],
  );
  if (!deal) return null;

  const sourceMeta = deal.source_meta ?? {};
  const companies: string[] = sourceMeta.directMetadata?.companies ?? [];

  if (companies.length === 0) {
    log.debug({ dealThoughtId }, 'Deal has no associated companies, skipping synthesis');
    return null;
  }

  // Resolve company name to entity
  const companyName = companies[0];
  const { rows: entityRows } = await pool.query(
    `SELECT id FROM entities WHERE canonical_name = $1 AND entity_type = 'company' LIMIT 1`,
    [companyName.toLowerCase()],
  );

  // Fallback: try alias match
  let companyEntityId: string | null = entityRows[0]?.id ?? null;
  if (!companyEntityId) {
    const { rows: aliasRows } = await pool.query(
      `SELECT id FROM entities WHERE $1 = ANY(aliases) AND entity_type = 'company' LIMIT 1`,
      [companyName.toLowerCase()],
    );
    companyEntityId = aliasRows[0]?.id ?? null;
  }

  // Gather related thoughts
  let relatedThoughts: Array<{ id: string; content: string; summary: string | null; thought_type: string | null; source: string; created_at: Date }> = [];
  if (companyEntityId) {
    const thoughts = await fetchThoughtsForEntity(pool, companyEntityId, { limit: 20 }, null);
    // Filter to relevant sources and exclude child chunks
    relatedThoughts = thoughts.filter((t: any) =>
      ['fathom', 'hubspot'].includes(t.source) && t.thought_type !== 'deal',
    );
  }

  // If no related thoughts found, nothing to synthesize beyond the deal record
  if (relatedThoughts.length === 0) {
    log.debug({ dealThoughtId, companyName }, 'No related thoughts found for deal company');
    // Store minimal synthesis so we don't retry immediately
    const minimalSynthesis: DealSynthesis = {
      summary: deal.content,
      key_facts: { contacts: sourceMeta.directMetadata?.people ?? [] },
      call_history: [],
      sources: [],
      source_count: 0,
      synthesized_at: new Date().toISOString(),
    };
    await storeSynthesis(pool, dealThoughtId, sourceMeta, minimalSynthesis);
    return minimalSynthesis;
  }

  // Build context for LLM
  const thoughtsText = relatedThoughts.map((t, i) => {
    const date = new Date(t.created_at).toISOString().slice(0, 10);
    const text = t.summary || t.content.slice(0, 1500);
    return `[${i + 1}] (${t.source}, ${date}, ${t.thought_type || 'note'}) ${text}`;
  }).join('\n\n');

  const prompt = `DEAL RECORD:\n${deal.content}\n\nRELATED CALLS & NOTES (${relatedThoughts.length} items):\n${thoughtsText}`;

  // Call LLM
  const response = await fetch(`${config.ollamaBaseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: config.extractionModel,
      stream: false,
      messages: [
        { role: 'system', content: DEAL_SYNTHESIS_PROMPT },
        { role: 'user', content: prompt },
      ],
    }),
    signal: AbortSignal.timeout(OLLAMA_LLM_TIMEOUT_MS),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Ollama deal synthesis failed (${response.status}): ${errorText}`);
  }

  const data = await response.json() as { message: { content: string } };
  const raw = data.message.content.trim();

  // Parse JSON response
  let parsed: any;
  try {
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON found');
    parsed = JSON.parse(jsonMatch[0]);
    if (!parsed.summary) throw new Error('Missing summary field');
  } catch (err) {
    log.error({ raw, dealThoughtId }, 'Failed to parse deal synthesis response');
    throw new Error(`Failed to parse deal synthesis: ${(err as Error).message}`);
  }

  const synthesis: DealSynthesis = {
    summary: parsed.summary,
    key_facts: parsed.key_facts ?? {},
    call_history: Array.isArray(parsed.call_history) ? parsed.call_history : [],
    sources: relatedThoughts.map((t) => t.id),
    source_count: relatedThoughts.length,
    synthesized_at: new Date().toISOString(),
  };

  await storeSynthesis(pool, dealThoughtId, sourceMeta, synthesis);
  return synthesis;
}

async function storeSynthesis(
  pool: pg.Pool,
  dealThoughtId: string,
  sourceMeta: Record<string, unknown>,
  synthesis: DealSynthesis,
): Promise<void> {
  const updatedMeta = { ...sourceMeta, deal_synthesis: synthesis };
  await pool.query(
    `UPDATE thoughts SET source_meta = $1 WHERE id = $2`,
    [JSON.stringify(updatedMeta), dealThoughtId],
  );
}

/** Find deals that need synthesis and process a batch */
export async function synthesizeStaleDeals(
  pool: pg.Pool,
  config: SynthesizerConfig,
): Promise<number> {
  const { rows } = await pool.query(
    `SELECT t.id
     FROM thoughts t
     WHERE t.thought_type = 'deal'
       AND t.source = 'hubspot'
       AND t.parent_id IS NULL
       AND (
         t.source_meta->'deal_synthesis' IS NULL
         OR (t.source_meta->'deal_synthesis'->>'synthesized_at')::timestamptz
            < NOW() - ($1 || ' days')::interval
       )
     ORDER BY t.created_at DESC
     LIMIT $2`,
    [DEAL_SYNTHESIS_STALE_DAYS, DEAL_SYNTHESIS_BATCH_SIZE],
  );

  let synthesized = 0;
  for (const deal of rows) {
    // Yield to chat — stop processing so Ollama can serve the chat request
    if (isChatActive()) break;

    try {
      const result = await synthesizeDeal(deal.id, pool, config);
      if (result) synthesized++;
    } catch (err) {
      log.error({ err, dealThoughtId: deal.id }, 'Deal synthesis failed');
    }
  }

  return synthesized;
}
