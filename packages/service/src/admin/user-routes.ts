import { Router } from 'express';
import express from 'express';
import type pg from 'pg';
import { generateApiKey } from '../user-context.js';
import { logAudit } from '../audit.js';
import { createChildLogger } from '../logger.js';

const VALID_ROLES = ['owner', 'admin', 'member'];

export function createUserRoutes(pool: pg.Pool): Router {
  const log = createChildLogger('user-admin');
  const getIp = (req: any) => {
    const xff = req.headers['x-forwarded-for'];
    return typeof xff === 'string' ? xff.split(',')[0].trim() : req.socket?.remoteAddress ?? null;
  };
  const router = Router();
  router.use(express.json());

  // List users
  router.get('/', async (_req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT u.id, u.email, u.display_name, u.role, u.entity_id,
                u.slack_user_id, u.telegram_user_id, u.active,
                u.created_at, u.updated_at,
                (SELECT COUNT(*) FROM access_keys ak WHERE ak.user_id = u.id AND ak.active = true)::int as active_key_count
         FROM users u
         ORDER BY u.created_at ASC`,
      );
      res.json(rows);
    } catch (err) {
      log.error({ err }, 'List users error');
      res.status(500).json({ error: 'Internal error' });
    }
  });

  // Create user
  router.post('/', async (req, res) => {
    try {
      const { email, display_name, role, slack_user_id, telegram_user_id } = req.body;

      if (!email || typeof email !== 'string' || !email.includes('@')) {
        res.status(400).json({ error: 'Valid email is required' });
        return;
      }
      if (!display_name || typeof display_name !== 'string' || !display_name.trim()) {
        res.status(400).json({ error: 'display_name is required' });
        return;
      }
      if (role && !VALID_ROLES.includes(role)) {
        res.status(400).json({ error: `role must be one of: ${VALID_ROLES.join(', ')}` });
        return;
      }

      const { rows: [user] } = await pool.query(
        `INSERT INTO users (email, display_name, role, slack_user_id, telegram_user_id)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, email, display_name, role, active, created_at`,
        [
          email.toLowerCase().trim(),
          display_name.trim(),
          role || 'member',
          slack_user_id || null,
          telegram_user_id || null,
        ],
      );

      logAudit(pool, {
        userId: req.userContext?.userId,
        action: 'create_user',
        resourceType: 'user',
        resourceId: user.id,
        metadata: { email: user.email, role: user.role },
        ipAddress: getIp(req),
      });

      res.json(user);
    } catch (err: any) {
      if (err.code === '23505') { // unique_violation
        res.status(409).json({ error: 'User with this email already exists' });
        return;
      }
      log.error({ err }, 'Create user error');
      res.status(500).json({ error: 'Internal error' });
    }
  });

  // Update user
  router.patch('/:id', async (req, res) => {
    try {
      const updates: string[] = [];
      const params: unknown[] = [];
      let idx = 1;

      if ('display_name' in req.body && req.body.display_name?.trim()) {
        updates.push(`display_name = $${idx++}`);
        params.push(req.body.display_name.trim());
      }
      if ('role' in req.body) {
        if (!VALID_ROLES.includes(req.body.role)) {
          res.status(400).json({ error: `role must be one of: ${VALID_ROLES.join(', ')}` });
          return;
        }
        updates.push(`role = $${idx++}`);
        params.push(req.body.role);
      }
      if ('active' in req.body) {
        updates.push(`active = $${idx++}`);
        params.push(!!req.body.active);
      }
      if ('slack_user_id' in req.body) {
        updates.push(`slack_user_id = $${idx++}`);
        params.push(req.body.slack_user_id || null);
      }
      if ('telegram_user_id' in req.body) {
        updates.push(`telegram_user_id = $${idx++}`);
        params.push(req.body.telegram_user_id || null);
      }
      if ('entity_id' in req.body) {
        updates.push(`entity_id = $${idx++}`);
        params.push(req.body.entity_id || null);
      }

      if (updates.length === 0) {
        res.status(400).json({ error: 'No fields to update' });
        return;
      }

      params.push(req.params.id);
      const { rows } = await pool.query(
        `UPDATE users SET ${updates.join(', ')} WHERE id = $${idx}
         RETURNING id, email, display_name, role, active, entity_id, slack_user_id, telegram_user_id`,
        params,
      );

      if (rows.length === 0) {
        res.status(404).json({ error: 'User not found' });
        return;
      }

      logAudit(pool, {
        userId: req.userContext?.userId,
        action: 'update_user',
        resourceType: 'user',
        resourceId: req.params.id,
        metadata: { updates: Object.keys(req.body) },
        ipAddress: getIp(req),
      });

      res.json(rows[0]);
    } catch (err) {
      log.error({ err }, 'Update user error');
      res.status(500).json({ error: 'Internal error' });
    }
  });

  // Generate API key for user
  router.post('/:id/keys', async (req, res) => {
    try {
      const name = req.body?.name || 'Default key';

      // Verify user exists
      const { rows: userRows } = await pool.query(
        `SELECT id FROM users WHERE id = $1`,
        [req.params.id],
      );
      if (userRows.length === 0) {
        res.status(404).json({ error: 'User not found' });
        return;
      }

      const { rawKey, keyId } = await generateApiKey(req.params.id, name, pool);

      logAudit(pool, {
        userId: req.userContext?.userId,
        action: 'generate_key',
        resourceType: 'access_key',
        resourceId: keyId,
        metadata: { for_user: req.params.id, name },
        ipAddress: getIp(req),
      });

      res.json({
        key_id: keyId,
        raw_key: rawKey,
        message: 'Save this key — it will not be shown again.',
      });
    } catch (err) {
      log.error({ err }, 'Generate key error');
      res.status(500).json({ error: 'Internal error' });
    }
  });

  // List keys for user
  router.get('/:id/keys', async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT id, name, active, scopes, created_at, last_used, expires_at
         FROM access_keys
         WHERE user_id = $1
         ORDER BY created_at DESC`,
        [req.params.id],
      );
      res.json(rows);
    } catch (err) {
      log.error({ err }, 'List keys error');
      res.status(500).json({ error: 'Internal error' });
    }
  });

  // Deactivate key
  router.delete('/:userId/keys/:keyId', async (req, res) => {
    try {
      const { rowCount } = await pool.query(
        `UPDATE access_keys SET active = false WHERE id = $1 AND user_id = $2`,
        [req.params.keyId, req.params.userId],
      );
      if (rowCount === 0) {
        res.status(404).json({ error: 'Key not found' });
        return;
      }

      logAudit(pool, {
        userId: req.userContext?.userId,
        action: 'deactivate_key',
        resourceType: 'access_key',
        resourceId: req.params.keyId,
        ipAddress: getIp(req),
      });

      res.json({ ok: true });
    } catch (err) {
      log.error({ err }, 'Deactivate key error');
      res.status(500).json({ error: 'Internal error' });
    }
  });

  return router;
}
