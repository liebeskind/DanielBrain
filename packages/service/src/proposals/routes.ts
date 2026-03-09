import { Router } from 'express';
import type pg from 'pg';
import { listProposalsInputSchema, reviewProposalInputSchema } from '@danielbrain/shared';
import { applyProposal, revertProposal } from './applier.js';
import type { Proposal } from '@danielbrain/shared';
import { captureFromApproval, captureFromRejection } from '../corrections/auto-capture.js';

export function createProposalRoutes(pool: pg.Pool): Router {
  const router = Router();

  // List proposals
  router.get('/', async (req, res) => {
    try {
      const input = listProposalsInputSchema.parse({
        status: req.query.status || undefined,
        proposal_type: req.query.proposal_type || undefined,
        limit: req.query.limit ? Number(req.query.limit) : undefined,
        offset: req.query.offset ? Number(req.query.offset) : undefined,
      });

      const conditions: string[] = [];
      const params: unknown[] = [];
      let paramIdx = 1;

      if (input.status) {
        conditions.push(`status = $${paramIdx++}`);
        params.push(input.status);
      }
      if (input.proposal_type) {
        conditions.push(`proposal_type = $${paramIdx++}`);
        params.push(input.proposal_type);
      }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

      const { rows } = await pool.query(
        `SELECT p.*, e.name as entity_name, e.entity_type, e.profile_summary as entity_profile
         FROM proposals p
         LEFT JOIN entities e ON p.entity_id = e.id
         ${where ? where.replace(/\b(status|proposal_type)\b/g, 'p.$1') : ''}
         ORDER BY p.created_at DESC
         LIMIT $${paramIdx++} OFFSET $${paramIdx++}`,
        [...params, input.limit, input.offset]
      );

      // Get total count for pagination
      const { rows: countRows } = await pool.query(
        `SELECT COUNT(*) as total FROM proposals p ${where ? where.replace(/\b(status|proposal_type)\b/g, 'p.$1') : ''}`,
        params
      );

      // Batch-fetch context about each entity: how do we know them?
      const entityIds = [...new Set(rows.filter((r: any) => r.entity_id).map((r: any) => r.entity_id))];
      let excerptsByEntity: Record<string, Array<{ excerpt: string; source: string; source_meta: Record<string, unknown> | null; created_at: string }>> = {};

      if (entityIds.length > 0) {
        const { rows: excerptRows } = await pool.query(
          `WITH ranked AS (
             SELECT
               te.entity_id,
               e.name as entity_name,
               te.relationship,
               t.content,
               t.summary,
               t.source,
               t.source_meta,
               t.thought_type,
               t.created_at,
               ROW_NUMBER() OVER (PARTITION BY te.entity_id ORDER BY t.created_at DESC) as rn
             FROM thought_entities te
             JOIN thoughts t ON t.id = te.thought_id
             JOIN entities e ON e.id = te.entity_id
             WHERE te.entity_id = ANY($1)
               AND t.parent_id IS NULL
           )
           SELECT entity_id, entity_name, relationship, content, summary,
                  source, source_meta, thought_type, created_at
           FROM ranked
           WHERE rn <= 5`,
          [entityIds]
        );
        for (const row of excerptRows) {
          if (!excerptsByEntity[row.entity_id]) excerptsByEntity[row.entity_id] = [];

          const sourceMeta = row.source_meta
            ? (typeof row.source_meta === 'string' ? JSON.parse(row.source_meta) : row.source_meta)
            : null;

          // Build a tight, identity-focused excerpt
          const parts: string[] = [];

          // Relationship context
          const rel = row.relationship as string;
          if (rel === 'from') {
            parts.push('Participant');
          } else if (rel === 'assigned_to') {
            parts.push('Action item assignee');
          } else if (rel === 'about') {
            parts.push('Discussed');
          }

          // Source label (compute early, used in excerpt)
          let sourceLabel = row.source;
          if (sourceMeta) {
            if (sourceMeta.title) sourceLabel = sourceMeta.title as string;
            else if (sourceMeta.channel_name) sourceLabel += ' #' + sourceMeta.channel_name;
          }

          // For meeting transcripts: use summary if available, skip raw transcript metadata
          const name = (row.entity_name || '').toLowerCase();
          if (row.summary) {
            // Strip markdown links [text](url) → text, and remove bare URLs
            const cleanSummary = row.summary
              .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
              .replace(/https?:\/\/\S+/g, '');
            // Extract sentences from summary mentioning the person
            const sumSentences = cleanSummary.split(/[.!?\n]+/).filter((s: string) => s.trim().length > 10);
            const relevant = sumSentences.filter((s: string) => s.toLowerCase().includes(name));
            if (relevant.length > 0) {
              const snippet = relevant.slice(0, 2).map((s: string) => s.trim()).join('. ');
              parts.push(snippet.length > 200 ? snippet.slice(0, 200) + '...' : snippet);
            } else {
              // Summary exists but doesn't mention name — take first substantive line
              const firstLine = sumSentences.find((s: string) => !s.startsWith('#') && s.trim().length > 20);
              if (firstLine) parts.push(firstLine.trim().slice(0, 150));
            }
          } else {
            // No summary — extract from content, skipping metadata preamble
            // Skip lines that look like metadata (timestamps, participant lists, headers)
            const lines = row.content.split('\n').filter((s: string) => {
              const t = s.trim();
              if (!t || t.length < 15) return false;
              if (/^(Duration|Participants|Recorded by|Summary|Transcript|##|\d{4}-\d{2}-\d{2})/i.test(t)) return false;
              if (/^https?:\/\//.test(t)) return false;
              return true;
            });
            const relevant = lines.filter((s: string) => s.toLowerCase().includes(name));
            if (relevant.length > 0) {
              const snippet = relevant.slice(0, 2).map((s: string) => s.trim()).join('. ');
              parts.push(snippet.length > 200 ? snippet.slice(0, 200) + '...' : snippet);
            } else if (lines.length > 0) {
              parts.push(lines[0].trim().slice(0, 150));
            }
          }

          excerptsByEntity[row.entity_id].push({
            excerpt: parts.join(' — '),
            source: sourceLabel,
            source_meta: sourceMeta,
            created_at: row.created_at,
          });
        }
      }

      // Attach entity_context to each proposal
      const enrichedProposals = rows.map((p: any) => ({
        ...p,
        entity_context: p.entity_id ? {
          name: p.entity_name,
          type: p.entity_type,
          profile: p.entity_profile || null,
          recent_excerpts: excerptsByEntity[p.entity_id] || [],
        } : null,
      }));

      res.json({
        proposals: enrichedProposals,
        total: parseInt(countRows[0].total, 10),
        limit: input.limit,
        offset: input.offset,
      });
    } catch (err) {
      console.error('List proposals error:', err);
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // Bulk re-enrich: reset all rejected enrichment proposals
  // Must be registered before /:id routes to avoid matching "bulk" as an id
  router.post('/bulk/re-enrich-rejected', async (req, res) => {
    try {
      // 1. Find all rejected enrichment proposals
      const { rows: rejected } = await pool.query(
        `SELECT p.*, e.name as entity_name
         FROM proposals p
         LEFT JOIN entities e ON p.entity_id = e.id
         WHERE p.proposal_type = 'entity_enrichment' AND p.status = 'rejected'`
      );

      if (rejected.length === 0) {
        res.json({ ok: true, reset_count: 0, message: 'No rejected enrichment proposals to reset.' });
        return;
      }

      // 2. Auto-capture corrections from each (non-blocking per item)
      for (const proposal of rejected) {
        await captureFromRejection(proposal as Proposal, proposal.reviewer_notes, pool).catch(() => {});
      }

      // 3. Mark all as 'failed' so findCandidates won't block on them
      // findCandidates blocks on: pending, approved, applied, rejected — but NOT failed
      await pool.query(
        `UPDATE proposals SET status = 'failed', reviewer_notes = COALESCE(reviewer_notes, '') || ' [Reset for re-enrichment]', updated_at = NOW()
         WHERE proposal_type = 'entity_enrichment' AND status = 'rejected'`
      );

      res.json({
        ok: true,
        reset_count: rejected.length,
        corrections_captured: rejected.length,
        message: `Reset ${rejected.length} rejected enrichment proposals. Enricher will retry these entities on next poll cycle.`,
      });
    } catch (err) {
      console.error('Bulk re-enrich error:', err);
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Get single proposal
  router.get('/:id', async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT p.*, e.name as entity_name, e.entity_type
         FROM proposals p
         LEFT JOIN entities e ON p.entity_id = e.id
         WHERE p.id = $1`,
        [req.params.id]
      );

      if (rows.length === 0) {
        res.status(404).json({ error: 'Proposal not found' });
        return;
      }

      res.json(rows[0]);
    } catch (err) {
      console.error('Get proposal error:', err);
      res.status(500).json({ error: 'Internal error' });
    }
  });

  // Approve proposal
  router.post('/:id/approve', async (req, res) => {
    try {
      const input = reviewProposalInputSchema.parse({
        action: 'approve',
        reviewer_notes: req.body?.reviewer_notes,
      });

      // Allow corrected proposed_data (e.g. fixing a LinkedIn URL from needs_changes)
      const correctedData = req.body?.proposed_data || null;

      // Atomically transition from pending or needs_changes → approved
      const updateFields = correctedData
        ? `SET status = 'approved', reviewer_notes = $2, proposed_data = $3::jsonb, updated_at = NOW()`
        : `SET status = 'approved', reviewer_notes = $2, updated_at = NOW()`;
      const updateParams = correctedData
        ? [req.params.id, input.reviewer_notes || null, JSON.stringify(correctedData)]
        : [req.params.id, input.reviewer_notes || null];

      const { rows } = await pool.query(
        `UPDATE proposals
         ${updateFields}
         WHERE id = $1 AND status IN ('pending', 'needs_changes')
         RETURNING *`,
        updateParams
      );

      if (rows.length === 0) {
        const { rows: existing } = await pool.query(
          `SELECT status FROM proposals WHERE id = $1`,
          [req.params.id]
        );
        if (existing.length === 0) {
          res.status(404).json({ error: 'Proposal not found' });
        } else {
          res.status(409).json({ error: `Proposal already ${existing[0].status}` });
        }
        return;
      }

      const proposal = rows[0] as Proposal;

      // If auto_applied, it's already done — just mark applied
      // If not auto_applied, apply the change now
      if (!proposal.auto_applied) {
        try {
          await applyProposal(proposal, pool);
        } catch (applyErr) {
          await pool.query(
            `UPDATE proposals SET status = 'failed', reviewer_notes = $2
             WHERE id = $1`,
            [proposal.id, `Apply failed: ${(applyErr as Error).message}`]
          );
          res.status(500).json({ error: `Apply failed: ${(applyErr as Error).message}` });
          return;
        }
      }

      await pool.query(
        `UPDATE proposals SET status = 'applied', applied_at = NOW() WHERE id = $1`,
        [proposal.id]
      );

      // Auto-capture correction example (non-blocking)
      captureFromApproval(proposal, correctedData, pool).catch(() => {});

      res.json({ ok: true, proposal_id: proposal.id, status: 'applied' });
    } catch (err) {
      console.error('Approve proposal error:', err);
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // Reject proposal
  router.post('/:id/reject', async (req, res) => {
    try {
      const input = reviewProposalInputSchema.parse({
        action: 'reject',
        reviewer_notes: req.body?.reviewer_notes,
      });

      const { rows } = await pool.query(
        `UPDATE proposals
         SET status = 'rejected', reviewer_notes = $2, updated_at = NOW()
         WHERE id = $1 AND status IN ('pending', 'needs_changes')
         RETURNING *`,
        [req.params.id, input.reviewer_notes || null]
      );

      if (rows.length === 0) {
        const { rows: existing } = await pool.query(
          `SELECT status FROM proposals WHERE id = $1`,
          [req.params.id]
        );
        if (existing.length === 0) {
          res.status(404).json({ error: 'Proposal not found' });
        } else {
          res.status(409).json({ error: `Proposal already ${existing[0].status}` });
        }
        return;
      }

      const proposal = rows[0] as Proposal;

      // If auto_applied, revert the change
      if (proposal.auto_applied) {
        try {
          await revertProposal(proposal, pool);
        } catch (revertErr) {
          console.error('Revert failed:', revertErr);
          // Still mark as rejected, but note the failure
          await pool.query(
            `UPDATE proposals SET reviewer_notes = $2 WHERE id = $1`,
            [proposal.id, `${input.reviewer_notes || ''} [Revert failed: ${(revertErr as Error).message}]`.trim()]
          );
        }
      }

      // Auto-capture rejection as negative example (non-blocking)
      captureFromRejection(proposal, input.reviewer_notes || null, pool).catch(() => {});

      res.json({ ok: true, proposal_id: proposal.id, status: 'rejected' });
    } catch (err) {
      console.error('Reject proposal error:', err);
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // Needs changes
  router.post('/:id/needs-changes', async (req, res) => {
    try {
      const input = reviewProposalInputSchema.parse({
        action: 'needs_changes',
        reviewer_notes: req.body?.reviewer_notes,
      });

      const { rows } = await pool.query(
        `UPDATE proposals
         SET status = 'needs_changes', reviewer_notes = $2, updated_at = NOW()
         WHERE id = $1 AND status = 'pending'
         RETURNING *`,
        [req.params.id, input.reviewer_notes || null]
      );

      if (rows.length === 0) {
        const { rows: existing } = await pool.query(
          `SELECT status FROM proposals WHERE id = $1`,
          [req.params.id]
        );
        if (existing.length === 0) {
          res.status(404).json({ error: 'Proposal not found' });
        } else {
          res.status(409).json({ error: `Proposal already ${existing[0].status}` });
        }
        return;
      }

      res.json({ ok: true, proposal_id: rows[0].id, status: 'needs_changes' });
    } catch (err) {
      console.error('Needs-changes error:', err);
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // Re-enrich: reset a single entity's enrichment so the enricher retries
  router.post('/:id/re-enrich', async (req, res) => {
    try {
      // Find the proposal and its entity
      const { rows } = await pool.query(
        `SELECT p.*, e.name as entity_name
         FROM proposals p
         LEFT JOIN entities e ON p.entity_id = e.id
         WHERE p.id = $1 AND p.proposal_type = 'entity_enrichment'`,
        [req.params.id]
      );

      if (rows.length === 0) {
        res.status(404).json({ error: 'Enrichment proposal not found' });
        return;
      }

      const proposal = rows[0] as Proposal & { entity_name: string };

      // 1. Auto-capture correction from rejected/applied proposals
      if (proposal.status === 'rejected') {
        await captureFromRejection(proposal, proposal.reviewer_notes, pool).catch(() => {});
      }

      // 2. If applied, clear linkedin_url from entity metadata
      if (proposal.status === 'applied' && proposal.entity_id) {
        await pool.query(
          `UPDATE entities SET metadata = metadata - 'linkedin_url' - 'linkedin_title' - 'linkedin_snippet', updated_at = NOW()
           WHERE id = $1`,
          [proposal.entity_id]
        );
      }

      // 3. Mark proposal as 'failed' (not 'rejected') so findCandidates won't block on it
      // findCandidates blocks on: pending, approved, applied, rejected — but NOT failed
      await pool.query(
        `UPDATE proposals SET status = 'failed', reviewer_notes = COALESCE(reviewer_notes, '') || ' [Reset for re-enrichment]', updated_at = NOW()
         WHERE id = $1`,
        [proposal.id]
      );

      // 4. Clear any other blocking proposals for the same entity
      if (proposal.entity_id) {
        await pool.query(
          `UPDATE proposals SET status = 'failed', reviewer_notes = 'Superseded by re-enrichment'
           WHERE entity_id = $1 AND proposal_type = 'entity_enrichment' AND status IN ('pending', 'needs_changes', 'approved', 'applied', 'rejected') AND id != $2`,
          [proposal.entity_id, proposal.id]
        );
      }

      res.json({ ok: true, message: `Reset enrichment for ${rows[0].entity_name || proposal.entity_id}. Enricher will retry on next poll.` });
    } catch (err) {
      console.error('Re-enrich error:', err);
      res.status(500).json({ error: (err as Error).message });
    }
  });

  return router;
}
