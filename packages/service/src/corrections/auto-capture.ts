import type pg from 'pg';
import type { Proposal } from '@danielbrain/shared';
import { createCorrectionExample } from './store.js';

export async function captureFromApproval(
  proposal: Proposal,
  correctedData: Record<string, unknown> | null,
  pool: pg.Pool,
): Promise<string | null> {
  try {
    // Only capture if there was a correction (correctedData differs from original)
    if (!correctedData) return null;

    if (proposal.proposal_type === 'entity_enrichment') {
      const originalUrl = (proposal.proposed_data as Record<string, unknown>)?.linkedin_url;
      const correctedUrl = correctedData.linkedin_url;

      // Only capture if the URL actually changed
      if (originalUrl === correctedUrl) return null;

      // Parse search context from description
      const searchQuery = proposal.description || '';
      const entityName = proposal.title?.replace(/^LinkedIn URL for /, '') || '';

      // Extract company context from search description
      // Description format: 'Found via SerpAPI: "site:linkedin.com/in "Name" "Company""'
      // Strip the wrapper to get the raw query, then find quoted company terms
      const rawQuery = searchQuery
        .replace(/^Found via SerpAPI:\s*"?/, '')
        .replace(/"?\s*$/, '');
      const companyContext: string[] = [];
      const allQuoted = rawQuery.match(/"([^"]+)"/g);
      if (allQuoted) {
        for (const m of allQuoted) {
          const term = m.replace(/"/g, '');
          if (term === entityName || !term.trim()) continue;
          companyContext.push(term);
        }
      }

      return await createCorrectionExample({
        category: 'linkedin_search',
        input_context: {
          entity_name: entityName,
          search_query: searchQuery,
          company_context: companyContext,
        },
        actual_output: {
          linkedin_url: originalUrl || null,
        },
        expected_output: {
          linkedin_url: correctedUrl,
        },
        explanation: proposal.reviewer_notes || 'Manually corrected during approval',
        entity_id: proposal.entity_id,
        proposal_id: proposal.id,
        tags: ['auto-captured', 'approval-correction'],
      }, pool);
    }

    return null;
  } catch (err) {
    console.error('Failed to capture correction from approval:', err);
    return null;
  }
}

export async function captureFromRejection(
  proposal: Proposal,
  reviewerNotes: string | null,
  pool: pg.Pool,
): Promise<string | null> {
  try {
    if (proposal.proposal_type === 'entity_enrichment') {
      const proposedData = proposal.proposed_data as Record<string, unknown>;
      const searchQuery = proposal.description || '';
      const entityName = proposal.title?.replace(/^LinkedIn URL for /, '') || '';

      const companyMatch = searchQuery.match(/"([^"]+)"/g);
      const companyContext = companyMatch
        ? companyMatch.map(m => m.replace(/"/g, '')).filter(m => m !== entityName)
        : [];

      return await createCorrectionExample({
        category: 'linkedin_search',
        input_context: {
          entity_name: entityName,
          search_query: searchQuery,
          company_context: companyContext,
        },
        actual_output: {
          linkedin_url: proposedData?.linkedin_url || null,
        },
        expected_output: {
          rejected: true,
        },
        explanation: reviewerNotes || 'Rejected — wrong result',
        entity_id: proposal.entity_id,
        proposal_id: proposal.id,
        tags: ['auto-captured', 'rejection'],
      }, pool);
    }

    return null;
  } catch (err) {
    console.error('Failed to capture correction from rejection:', err);
    return null;
  }
}
