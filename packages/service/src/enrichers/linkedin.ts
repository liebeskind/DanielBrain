import type pg from 'pg';
import { LINKEDIN_ENRICHMENT_BATCH_SIZE, SERPAPI_DAILY_LIMIT } from '@danielbrain/shared';
import { createEnrichmentProposal } from '../proposals/helpers.js';

export interface LinkedInEnricherConfig {
  serpApiKey: string;
}

// In-memory daily counter, resets at midnight UTC
let dailySearchCount = 0;
let lastResetDate = new Date().toISOString().slice(0, 10);

function resetDailyCounterIfNeeded(): void {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== lastResetDate) {
    dailySearchCount = 0;
    lastResetDate = today;
  }
}

export function getDailySearchCount(): number {
  return dailySearchCount;
}

export function resetDailyCounter(): void {
  dailySearchCount = 0;
  lastResetDate = new Date().toISOString().slice(0, 10);
}

interface CandidateEntity {
  id: string;
  name: string;
  company_name: string | null;
  reviewer_hint: string | null;
}

async function findCandidates(pool: pg.Pool, batchSize: number): Promise<CandidateEntity[]> {
  // Find person entities without linkedin_url in metadata and no blocking enrichment proposal.
  // For company context: find the company most uniquely associated with this person,
  // excluding the globally most-mentioned company (likely the user's own org).
  // Also pull reviewer notes from any needs_changes proposal as search hints.
  const { rows } = await pool.query(
    `SELECT e.id, e.name,
       (SELECT e2.name
        FROM thought_entities te
        JOIN thought_entities te2 ON te2.thought_id = te.thought_id AND te2.entity_id != te.entity_id
        JOIN entities e2 ON e2.id = te2.entity_id AND e2.entity_type = 'company'
        WHERE te.entity_id = e.id
          AND e2.id != (
            SELECT id FROM entities
            WHERE entity_type = 'company'
            ORDER BY mention_count DESC
            LIMIT 1
          )
        GROUP BY e2.name
        ORDER BY COUNT(*) DESC
        LIMIT 1) as company_name,
       (SELECT p.reviewer_notes
        FROM proposals p
        WHERE p.entity_id = e.id
          AND p.proposal_type = 'entity_enrichment'
          AND p.status = 'needs_changes'
        ORDER BY p.created_at DESC
        LIMIT 1) as reviewer_hint
     FROM entities e
     WHERE e.entity_type = 'person'
       AND (e.metadata->>'linkedin_url') IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM proposals p
         WHERE p.entity_id = e.id
           AND p.proposal_type = 'entity_enrichment'
           AND p.status IN ('pending', 'approved', 'applied', 'rejected')
       )
     ORDER BY e.mention_count DESC
     LIMIT $1`,
    [batchSize]
  );
  return rows;
}

interface SerpApiResult {
  organic_results?: Array<{
    link: string;
    title: string;
    snippet: string;
  }>;
  error?: string;
}

interface LinkedInSearchResult {
  url: string;
  title: string;
  snippet: string;
}

async function searchLinkedIn(
  name: string,
  company: string | null,
  config: LinkedInEnricherConfig,
  reviewerHint?: string | null,
): Promise<LinkedInSearchResult | null> {
  // If reviewer left hints (e.g. "Myles from Provocative Earth"), extract keywords for the search
  let contextPart = '';
  if (reviewerHint) {
    // Strip any URLs from the hint, use remaining text as search context
    const hintText = reviewerHint.replace(/https?:\/\/\S+/g, '').trim();
    if (hintText.length > 0) {
      // Use the hint text as additional search context (unquoted for flexibility)
      contextPart = ` ${hintText}`;
    }
  } else if (company) {
    contextPart = ` "${company}"`;
  }
  const query = `site:linkedin.com/in "${name}"${contextPart}`;

  const url = new URL('https://serpapi.com/search.json');
  url.searchParams.set('api_key', config.serpApiKey);
  url.searchParams.set('engine', 'google');
  url.searchParams.set('q', query);
  url.searchParams.set('num', '1');

  const response = await fetch(url.toString());
  if (!response.ok) {
    console.error(`SerpAPI error: ${response.status} ${response.statusText}`);
    return null;
  }

  const data = (await response.json()) as SerpApiResult;
  if (data.error) {
    console.error(`SerpAPI error: ${data.error}`);
    return null;
  }

  if (!data.organic_results || data.organic_results.length === 0) return null;

  const result = data.organic_results[0];
  // Validate it's actually a LinkedIn profile URL
  if (/^https?:\/\/(www\.)?linkedin\.com\/in\//.test(result.link)) {
    return { url: result.link, title: result.title || '', snippet: result.snippet || '' };
  }

  return null;
}

export async function enrichLinkedInBatch(
  pool: pg.Pool,
  config: LinkedInEnricherConfig,
): Promise<number> {
  resetDailyCounterIfNeeded();

  if (dailySearchCount >= SERPAPI_DAILY_LIMIT) {
    return 0;
  }

  const remaining = SERPAPI_DAILY_LIMIT - dailySearchCount;
  const batchSize = Math.min(LINKEDIN_ENRICHMENT_BATCH_SIZE, remaining);
  const candidates = await findCandidates(pool, batchSize);

  let created = 0;
  for (const candidate of candidates) {
    if (dailySearchCount >= SERPAPI_DAILY_LIMIT) break;

    try {
      dailySearchCount++;
      const result = await searchLinkedIn(candidate.name, candidate.company_name, config, candidate.reviewer_hint);

      if (result) {
        let searchDesc: string;
        if (candidate.reviewer_hint) {
          const hintText = candidate.reviewer_hint.replace(/https?:\/\/\S+/g, '').trim();
          searchDesc = `site:linkedin.com/in "${candidate.name}" ${hintText}`;
        } else {
          const companyPart = candidate.company_name ? ` "${candidate.company_name}"` : '';
          searchDesc = `site:linkedin.com/in "${candidate.name}"${companyPart}`;
        }
        await createEnrichmentProposal(
          candidate.id,
          candidate.name,
          { linkedin_url: result.url, linkedin_title: result.title, linkedin_snippet: result.snippet },
          searchDesc,
          pool,
        );
        created++;
      }
    } catch (err) {
      console.error(`LinkedIn enrichment error for ${candidate.name}:`, err);
    }
  }

  return created;
}
