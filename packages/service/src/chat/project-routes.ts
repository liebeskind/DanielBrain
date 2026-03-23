import { Router } from 'express';
import express from 'express';
import type pg from 'pg';
import { createChildLogger } from '../logger.js';

const log = createChildLogger('chat-projects');

export function createProjectRoutes(pool: pg.Pool): Router {
  const router = Router();
  router.use(express.json());

  // List projects
  router.get('/', async (req, res) => {
    try {
      const userId = req.userContext?.userId;
      const { rows } = userId
        ? await pool.query(
            `SELECT id, name, created_at, updated_at
             FROM projects WHERE is_deleted = FALSE AND (user_id = $1 OR user_id IS NULL)
             ORDER BY name ASC`,
            [userId],
          )
        : await pool.query(
            `SELECT id, name, created_at, updated_at
             FROM projects WHERE is_deleted = FALSE
             ORDER BY name ASC`,
          );
      res.json(rows);
    } catch (err) {
      log.error({ err }, 'List projects error');
      res.status(500).json({ error: 'Internal error' });
    }
  });

  // Create project
  router.post('/', async (req, res) => {
    try {
      const { name } = req.body;
      if (!name || typeof name !== 'string' || !name.trim()) {
        res.status(400).json({ error: 'name is required' });
        return;
      }
      const { rows: [row] } = await pool.query(
        `INSERT INTO projects (name, user_id) VALUES ($1, $2)
         RETURNING id, name, created_at, updated_at`,
        [name.trim(), req.userContext?.userId ?? null],
      );
      res.json(row);
    } catch (err) {
      log.error({ err }, 'Create project error');
      res.status(500).json({ error: 'Internal error' });
    }
  });

  // Rename project
  router.patch('/:id', async (req, res) => {
    try {
      const { name } = req.body;
      if (!name || typeof name !== 'string' || !name.trim()) {
        res.status(400).json({ error: 'name is required' });
        return;
      }
      const { rows } = await pool.query(
        `UPDATE projects SET name = $1 WHERE id = $2 AND is_deleted = FALSE
         RETURNING id, name, created_at, updated_at`,
        [name.trim(), req.params.id],
      );
      if (rows.length === 0) {
        res.status(404).json({ error: 'Project not found' });
        return;
      }
      res.json(rows[0]);
    } catch (err) {
      log.error({ err }, 'Update project error');
      res.status(500).json({ error: 'Internal error' });
    }
  });

  // Delete project (soft)
  router.delete('/:id', async (req, res) => {
    try {
      // Unassign conversations from this project
      await pool.query(
        `UPDATE conversations SET project_id = NULL WHERE project_id = $1`,
        [req.params.id],
      );
      const { rowCount } = await pool.query(
        `UPDATE projects SET is_deleted = TRUE WHERE id = $1 AND is_deleted = FALSE`,
        [req.params.id],
      );
      if (rowCount === 0) {
        res.status(404).json({ error: 'Project not found' });
        return;
      }
      res.json({ ok: true });
    } catch (err) {
      log.error({ err }, 'Delete project error');
      res.status(500).json({ error: 'Internal error' });
    }
  });

  return router;
}
