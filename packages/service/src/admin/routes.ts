import { Router } from 'express';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import type pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createAdminRoutes(pool: pg.Pool): Router {
  const router = Router();

  // JSON body parsing for API routes
  router.use('/api', express.json());

  // Serve static files
  router.use(express.static(path.join(__dirname, 'static')));

  // ---- Entity stats API for dashboard ----
  router.get('/api/entities/stats', async (_req, res) => {
    try {
      const { rows: typeCounts } = await pool.query(
        `SELECT entity_type, COUNT(*) as count
         FROM entities
         GROUP BY entity_type
         ORDER BY count DESC`
      );

      const { rows: recentEntities } = await pool.query(
        `SELECT id, name, entity_type, mention_count, last_seen_at
         FROM entities
         ORDER BY last_seen_at DESC
         LIMIT 20`
      );

      const { rows: topEntities } = await pool.query(
        `SELECT id, name, entity_type, mention_count
         FROM entities
         ORDER BY mention_count DESC
         LIMIT 10`
      );

      const { rows: proposalCounts } = await pool.query(
        `SELECT status, COUNT(*) as count
         FROM proposals
         GROUP BY status`
      );

      res.json({
        type_counts: typeCounts,
        recent_entities: recentEntities,
        top_entities: topEntities,
        proposal_counts: proposalCounts,
      });
    } catch (err) {
      console.error('Entity stats error:', err);
      res.status(500).json({ error: 'Internal error' });
    }
  });

  // ---- Browse: stats ----
  router.get('/api/browse/stats', async (_req, res) => {
    try {
      const { rows: [totalRow] } = await pool.query(
        `SELECT COUNT(*) as total FROM thoughts WHERE parent_id IS NULL`
      );

      const { rows: bySource } = await pool.query(
        `SELECT source, COUNT(*) as count
         FROM thoughts
         WHERE parent_id IS NULL
         GROUP BY source
         ORDER BY count DESC`
      );

      res.json({
        total: parseInt(totalRow.total, 10),
        by_source: bySource.map((r: { source: string; count: string }) => ({ source: r.source, count: parseInt(r.count, 10) })),
      });
    } catch (err) {
      console.error('Browse stats error:', err);
      res.status(500).json({ error: 'Internal error' });
    }
  });

  // ---- Browse: list thoughts with filters ----
  router.get('/api/browse/thoughts', async (req, res) => {
    try {
      const limit = Math.min(parseInt(req.query.limit as string, 10) || 25, 100);
      const offset = parseInt(req.query.offset as string, 10) || 0;
      const search = (req.query.search as string || '').trim();
      const source = (req.query.source as string || '').trim();
      const thoughtType = (req.query.thought_type as string || '').trim();
      const sort = req.query.sort === 'oldest' ? 'ASC' : 'DESC';

      const conditions: string[] = ['t.parent_id IS NULL'];
      const params: (string | number)[] = [];
      let paramIdx = 1;

      if (search) {
        conditions.push(`(t.content ILIKE $${paramIdx} OR t.summary ILIKE $${paramIdx})`);
        params.push(`%${search}%`);
        paramIdx++;
      }

      if (source) {
        conditions.push(`t.source = $${paramIdx}`);
        params.push(source);
        paramIdx++;
      }

      if (thoughtType) {
        conditions.push(`t.thought_type = $${paramIdx}`);
        params.push(thoughtType);
        paramIdx++;
      }

      const whereClause = conditions.length > 0
        ? 'WHERE ' + conditions.join(' AND ')
        : '';

      // Get total count
      const { rows: [countRow] } = await pool.query(
        `SELECT COUNT(*) as total FROM thoughts t ${whereClause}`,
        params
      );

      // Get thoughts with linked entities
      const { rows: thoughts } = await pool.query(
        `SELECT t.id, t.content, t.summary, t.thought_type, t.source, t.source_meta,
                t.people, t.topics, t.action_items, t.sentiment,
                t.created_at, t.processed_at,
                COALESCE(
                  (SELECT json_agg(json_build_object(
                    'id', e.id, 'name', e.name, 'entity_type', e.entity_type
                  ) ORDER BY e.mention_count DESC)
                  FROM thought_entities te
                  JOIN entities e ON e.id = te.entity_id
                  WHERE te.thought_id = t.id),
                  '[]'::json
                ) as entities
         FROM thoughts t
         ${whereClause}
         ORDER BY t.created_at ${sort}
         LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
        [...params, limit, offset]
      );

      res.json({
        thoughts,
        total: parseInt(countRow.total, 10),
        limit,
        offset,
      });
    } catch (err) {
      console.error('Browse thoughts error:', err);
      res.status(500).json({ error: 'Internal error' });
    }
  });

  // ---- Ingest: save content to the brain ----
  router.post('/api/ingest', async (req, res) => {
    try {
      const { content, thought_type, source_meta } = req.body;

      if (!content || typeof content !== 'string' || !content.trim()) {
        res.status(400).json({ error: 'content is required' });
        return;
      }

      // Insert into queue for async processing (same pattern as Slack/Telegram)
      const meta = {
        ...(source_meta || {}),
        thought_type: thought_type || 'note',
      };

      const { rows: [row] } = await pool.query(
        `INSERT INTO queue (content, source, source_meta)
         VALUES ($1, 'manual', $2)
         RETURNING id`,
        [content.trim(), JSON.stringify(meta)]
      );

      res.json({ id: row.id, status: 'queued' });
    } catch (err) {
      console.error('Ingest error:', err);
      res.status(500).json({ error: 'Internal error' });
    }
  });

  return router;
}
