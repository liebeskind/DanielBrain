import { Router } from 'express';
import type pg from 'pg';
import { listProposalsInputSchema, reviewProposalInputSchema } from '@danielbrain/shared';
import { applyProposal, revertProposal } from './applier.js';
import type { Proposal } from '@danielbrain/shared';

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

      // Batch-fetch recent thought excerpts for all entity_ids
      // Dedup by content, extract a window around the entity name mention
      const entityIds = [...new Set(rows.filter((r: any) => r.entity_id).map((r: any) => r.entity_id))];
      let excerptsByEntity: Record<string, Array<{ excerpt: string; summary: string | null; source: string; source_meta: Record<string, unknown> | null; created_at: string }>> = {};

      if (entityIds.length > 0) {
        const { rows: excerptRows } = await pool.query(
          `WITH unique_thoughts AS (
             SELECT DISTINCT ON (te.entity_id, t.id)
               te.entity_id,
               e.name as entity_name,
               t.content,
               t.summary,
               t.source,
               t.source_meta,
               t.created_at
             FROM thought_entities te
             JOIN thoughts t ON t.id = te.thought_id
             JOIN entities e ON e.id = te.entity_id
             WHERE te.entity_id = ANY($1)
               AND t.parent_id IS NULL
             ORDER BY te.entity_id, t.id, t.created_at DESC
           ),
           deduped AS (
             SELECT DISTINCT ON (entity_id, LEFT(content, 200))
               entity_id, entity_name, content, summary, source, source_meta, created_at
             FROM unique_thoughts
             ORDER BY entity_id, LEFT(content, 200), created_at DESC
           ),
           ranked AS (
             SELECT *,
               ROW_NUMBER() OVER (PARTITION BY entity_id ORDER BY created_at DESC) as rn
             FROM deduped
           )
           SELECT entity_id, entity_name, content, summary, source, source_meta, created_at
           FROM ranked
           WHERE rn <= 3`,
          [entityIds]
        );
        for (const row of excerptRows) {
          if (!excerptsByEntity[row.entity_id]) excerptsByEntity[row.entity_id] = [];
          // Extract a ~200 char window around the entity name mention
          const name = row.entity_name?.toLowerCase() || '';
          const contentLower = row.content.toLowerCase();
          const namePos = contentLower.indexOf(name);
          let excerpt: string;
          if (namePos >= 0) {
            const start = Math.max(0, namePos - 40);
            excerpt = (start > 0 ? '...' : '') + row.content.slice(start, start + 200);
            if (start + 200 < row.content.length) excerpt += '...';
          } else {
            excerpt = row.content.slice(0, 200);
            if (row.content.length > 200) excerpt += '...';
          }
          const sourceMeta = row.source_meta
            ? (typeof row.source_meta === 'string' ? JSON.parse(row.source_meta) : row.source_meta)
            : null;
          excerptsByEntity[row.entity_id].push({
            excerpt,
            summary: row.summary || null,
            source: row.source,
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

  return router;
}
