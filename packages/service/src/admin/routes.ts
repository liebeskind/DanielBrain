import { Router } from 'express';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import type pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createAdminRoutes(pool: pg.Pool): Router {
  const router = Router();

  // Serve static files
  router.use(express.static(path.join(__dirname, 'static')));

  // Entity stats API for dashboard
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

  return router;
}
