import { Router } from 'express';
import express from 'express';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import multer from 'multer';
import type pg from 'pg';
import type { Config } from '../config.js';
import { syncFathomMeetings } from '../fathom/sync.js';
import { parseFile } from '../parsers/index.js';
import { createJob, getJob, updateJob, listJobs } from '../transcribe/job-tracker.js';
import { runTranscription, formatAsSrt, generateSummary, applySpeakerNames } from '../transcribe/service.js';
import { createChildLogger } from '../logger.js';
import { sanitizeError } from '../errors.js';
import { logAudit } from '../audit.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const log = createChildLogger('admin');

interface IntegrationDef {
  id: string;
  name: string;
  description: string;
  category: string;
  source: string; // source value in thoughts table
  can_pull: boolean;
  webhook_path: string | null;
  isEnabled: (config: Config) => boolean;
}

const INTEGRATIONS: IntegrationDef[] = [
  {
    id: 'fathom',
    name: 'Fathom',
    description: 'Meeting transcripts and call recordings',
    category: 'meetings',
    source: 'fathom',
    can_pull: true,
    webhook_path: '/fathom/events',
    isEnabled: (c) => !!(c.fathomApiKey && c.fathomWebhookSecret),
  },
  {
    id: 'slack',
    name: 'Slack',
    description: 'Channel messages and conversations',
    category: 'messaging',
    source: 'slack',
    can_pull: false,
    webhook_path: '/slack/events',
    isEnabled: (c) => !!(c.slackBotToken && c.slackSigningSecret),
  },
  {
    id: 'telegram',
    name: 'Telegram',
    description: 'Bot messages and group chats',
    category: 'messaging',
    source: 'telegram',
    can_pull: false,
    webhook_path: '/telegram/updates',
    isEnabled: (c) => !!(c.telegramBotToken && c.telegramWebhookSecret),
  },
  {
    id: 'manual',
    name: 'Manual',
    description: 'Content added via the admin dashboard or MCP tools',
    category: 'manual',
    source: 'manual',
    can_pull: false,
    webhook_path: null,
    isEnabled: () => true,
  },
];

export function createAdminRoutes(pool: pg.Pool, config: Config): Router {
  const router = Router();

  // JSON body parsing for API routes
  router.use('/api', express.json());

  // Serve static files
  router.use(express.static(path.join(__dirname, 'static')));

  // ---- Integration stats API ----
  router.get('/api/integrations/stats', async (_req, res) => {
    try {
      const results = await Promise.all(
        INTEGRATIONS.map(async (def) => {
          const { rows: [stats] } = await pool.query(
            `SELECT
              COUNT(DISTINCT t.id) as thought_count,
              COUNT(DISTINCT e.id) as entity_count,
              COUNT(DISTINCT e.id) FILTER (WHERE e.entity_type = 'person') as people_count,
              COUNT(DISTINCT e.id) FILTER (WHERE e.entity_type = 'company') as company_count,
              MIN(t.created_at) as first_pulled,
              MAX(t.created_at) as last_pulled
            FROM thoughts t
            LEFT JOIN thought_entities te ON te.thought_id = t.id
            LEFT JOIN entities e ON e.id = te.entity_id
            WHERE t.source = $1 AND t.parent_id IS NULL`,
            [def.source],
          );

          // Count action items separately (thoughts with non-empty action_items arrays)
          const { rows: [aiRow] } = await pool.query(
            `SELECT COUNT(*) as action_item_count
            FROM thoughts
            WHERE source = $1 AND parent_id IS NULL
              AND action_items IS NOT NULL
              AND array_length(action_items, 1) > 0`,
            [def.source],
          );

          // Count pending queue items for this source
          const { rows: [queueRow] } = await pool.query(
            `SELECT COUNT(*) as pending_count
            FROM queue
            WHERE source = $1 AND processed_at IS NULL`,
            [def.source],
          );

          return {
            id: def.id,
            name: def.name,
            description: def.description,
            category: def.category,
            enabled: def.isEnabled(config),
            can_pull: def.can_pull,
            webhook_path: def.webhook_path,
            stats: {
              thought_count: parseInt(stats.thought_count, 10),
              entity_count: parseInt(stats.entity_count, 10),
              people_count: parseInt(stats.people_count, 10),
              company_count: parseInt(stats.company_count, 10),
              action_item_count: parseInt(aiRow.action_item_count, 10),
              first_pulled: stats.first_pulled,
              last_pulled: stats.last_pulled,
              pending_count: parseInt(queueRow.pending_count, 10),
            },
          };
        }),
      );

      res.json(results);
    } catch (err) {
      log.error({ err }, 'Integration stats error');
      res.status(500).json({ error: 'Internal error' });
    }
  });

  // ---- Pull latest for an integration ----
  router.post('/api/integrations/:id/pull', async (req, res) => {
    const { id } = req.params;

    if (id === 'fathom') {
      if (!config.fathomApiKey) {
        res.status(400).json({ error: 'Fathom API key not configured' });
        return;
      }

      try {
        const result = await syncFathomMeetings(pool, { fathomApiKey: config.fathomApiKey });
        res.json({ ok: true, ...result });
      } catch (err) {
        log.error({ err }, 'Fathom pull error');
        res.status(500).json({ error: 'Pull failed' });
      }
      return;
    }

    res.status(400).json({ error: `Integration '${id}' does not support pull` });
  });

  // ---- Entity stats API for dashboard ----
  const VALID_ENTITY_TYPES = ['person', 'company', 'topic', 'product', 'project', 'place'];
  const VALID_ENTITY_SORTS = ['mentions', 'last_seen', 'relationships', 'inputs'];

  router.get('/api/entities/stats', async (req, res) => {
    try {
      const sortParam = (req.query.sort as string) || 'mentions';
      const sort = VALID_ENTITY_SORTS.includes(sortParam) ? sortParam : 'mentions';
      const limit = Math.min(parseInt(req.query.limit as string, 10) || 30, 200);
      const offset = parseInt(req.query.offset as string, 10) || 0;
      const entityType = (req.query.entity_type as string) || '';

      const { rows: typeCounts } = await pool.query(
        `SELECT entity_type, COUNT(*) as count
         FROM entities
         WHERE mention_count > 0
         GROUP BY entity_type
         ORDER BY count DESC`
      );

      // Build conditions
      const conditions: string[] = ['e.mention_count > 0'];
      const params: (string | number)[] = [];
      let paramIdx = 1;

      if (entityType && VALID_ENTITY_TYPES.includes(entityType)) {
        conditions.push(`e.entity_type = $${paramIdx}`);
        params.push(entityType);
        paramIdx++;
      }

      const whereClause = 'WHERE ' + conditions.join(' AND ');

      const orderClause = sort === 'last_seen'
        ? 'ORDER BY last_seen_at DESC NULLS LAST'
        : sort === 'relationships'
        ? 'ORDER BY relationship_count DESC'
        : sort === 'inputs'
        ? 'ORDER BY input_count DESC'
        : 'ORDER BY e.mention_count DESC';

      const { rows: entities } = await pool.query(
        `SELECT e.id, e.name, e.entity_type, e.mention_count,
                COALESCE(
                  (SELECT MAX(t.created_at) FROM thought_entities te
                   JOIN thoughts t ON t.id = te.thought_id
                   WHERE te.entity_id = e.id),
                  e.last_seen_at
                ) as last_seen_at,
                COALESCE(
                  (SELECT COUNT(*) FROM entity_relationships er
                   WHERE (er.source_id = e.id OR er.target_id = e.id)
                   AND er.is_explicit = TRUE
                   AND er.invalid_at IS NULL),
                  0
                )::int as relationship_count,
                COALESCE(
                  (SELECT COUNT(DISTINCT te2.thought_id) FROM thought_entities te2
                   WHERE te2.entity_id = e.id),
                  0
                )::int as input_count
         FROM entities e
         ${whereClause}
         ${orderClause}
         LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
        [...params, limit, offset]
      );

      const { rows: [totalRow] } = await pool.query(
        `SELECT COUNT(*) as total FROM entities e ${whereClause}`,
        params
      );

      const { rows: proposalCounts } = await pool.query(
        `SELECT status, COUNT(*) as count
         FROM proposals
         GROUP BY status`
      );

      res.json({
        type_counts: typeCounts,
        entities,
        total: parseInt(totalRow.total, 10),
        limit,
        offset,
        proposal_counts: proposalCounts,
      });
    } catch (err) {
      log.error({ err }, 'Entity stats error');
      res.status(500).json({ error: 'Internal error' });
    }
  });

  // ---- Proposal stats API ----
  router.get('/api/proposals/stats', async (_req, res) => {
    try {
      const { rows: statusCounts } = await pool.query(
        `SELECT status, COUNT(*) as count
         FROM proposals
         GROUP BY status`
      );

      const { rows: typeCounts } = await pool.query(
        `SELECT proposal_type, COUNT(*) as count
         FROM proposals
         GROUP BY proposal_type
         ORDER BY count DESC`
      );

      const { rows: [totals] } = await pool.query(
        `SELECT COUNT(*) as total,
                COUNT(*) FILTER (WHERE status = 'pending') as pending
         FROM proposals`
      );

      res.json({
        status_counts: statusCounts,
        type_counts: typeCounts,
        total: parseInt(totals.total, 10),
        pending: parseInt(totals.pending, 10),
      });
    } catch (err) {
      log.error({ err }, 'Proposal stats error');
      res.status(500).json({ error: 'Internal error' });
    }
  });

  // ---- URL inventory API ----
  router.get('/api/url-inventory', async (_req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT t.source_meta->'extracted_urls' as urls
         FROM thoughts t
         WHERE t.source = 'hubspot'
           AND t.source_meta->>'object_type' = 'note'
           AND t.source_meta->'extracted_urls' IS NOT NULL
           AND jsonb_array_length(t.source_meta->'extracted_urls') > 0
           AND t.parent_id IS NULL`
      );

      const byType: Record<string, number> = {};
      const byStatus: Record<string, number> = {};
      const authRequired: Array<{ url: string; type: string; details?: string }> = [];

      for (const row of rows) {
        const urls = (row.urls || []) as Array<{ url: string; type: string; fetchable: boolean; processed?: string; details?: string }>;
        for (const u of urls) {
          byType[u.type] = (byType[u.type] || 0) + 1;
          const status = u.processed || 'unprocessed';
          byStatus[status] = (byStatus[status] || 0) + 1;
          if (u.processed === 'auth_required') {
            authRequired.push({ url: u.url, type: u.type, details: u.details });
          }
        }
      }

      res.json({
        total_notes_with_urls: rows.length,
        by_type: byType,
        by_status: byStatus,
        auth_required: authRequired,
      });
    } catch (err) {
      log.error({ err }, 'URL inventory error');
      res.status(500).json({ error: 'Internal error' });
    }
  });

  // ---- Facts API ----
  router.get('/api/facts/stats', async (_req, res) => {
    try {
      const { rows: [counts] } = await pool.query(
        `SELECT count(*) as total,
                count(*) FILTER (WHERE invalid_at IS NULL) as active,
                count(*) FILTER (WHERE invalid_at IS NOT NULL) as invalidated
         FROM facts`
      );
      const { rows: typeCounts } = await pool.query(
        `SELECT fact_type, count(*) as count FROM facts WHERE invalid_at IS NULL GROUP BY 1 ORDER BY 2 DESC`
      );
      res.json({
        total: parseInt(counts.total, 10),
        active: parseInt(counts.active, 10),
        invalidated: parseInt(counts.invalidated, 10),
        by_type: typeCounts,
      });
    } catch (err) {
      log.error({ err }, 'Facts stats error');
      res.status(500).json({ error: 'Internal error' });
    }
  });

  router.get('/api/facts/contradictions', async (_req, res) => {
    try {
      // For each invalidated fact, find the closest active fact about the same subject
      const { rows } = await pool.query(
        `SELECT
           f.id,
           f.statement as original_statement,
           f.fact_type,
           f.confidence,
           s.name as subject_name,
           s.entity_type as subject_type,
           closest.statement as closest_active_statement,
           closest.similarity
         FROM facts f
         LEFT JOIN entities s ON s.id = f.subject_entity_id
         LEFT JOIN LATERAL (
           SELECT f2.statement,
                  round((1 - ((f.embedding::halfvec(768)) <=> (f2.embedding::halfvec(768))))::numeric, 4) as similarity
           FROM facts f2
           WHERE f2.invalid_at IS NULL
             AND f2.embedding IS NOT NULL
             AND f2.id != f.id
             AND (f2.subject_entity_id = f.subject_entity_id OR f.subject_entity_id IS NULL)
           ORDER BY f2.embedding::halfvec(768) <=> f.embedding::halfvec(768)
           LIMIT 1
         ) closest ON true
         WHERE f.invalid_at IS NOT NULL
         ORDER BY closest.similarity ASC NULLS LAST`
      );

      res.json({ contradictions: rows });
    } catch (err) {
      log.error({ err }, 'Facts contradictions error');
      res.status(500).json({ error: 'Internal error' });
    }
  });

  router.post('/api/facts/:id/restore', async (req, res) => {
    try {
      await pool.query(
        `UPDATE facts SET invalid_at = NULL, invalidated_by = NULL WHERE id = $1`,
        [req.params.id],
      );
      res.json({ ok: true });
    } catch (err) {
      log.error({ err }, 'Fact restore error');
      res.status(500).json({ error: 'Internal error' });
    }
  });

  router.post('/api/facts/:id/delete', async (req, res) => {
    try {
      await pool.query(`DELETE FROM facts WHERE id = $1`, [req.params.id]);
      res.json({ ok: true });
    } catch (err) {
      log.error({ err }, 'Fact delete error');
      res.status(500).json({ error: 'Internal error' });
    }
  });

  router.post('/api/facts/restore-all', async (_req, res) => {
    try {
      const { rowCount } = await pool.query(
        `UPDATE facts SET invalid_at = NULL, invalidated_by = NULL WHERE invalid_at IS NOT NULL`
      );
      res.json({ restored: rowCount });
    } catch (err) {
      log.error({ err }, 'Fact restore-all error');
      res.status(500).json({ error: 'Internal error' });
    }
  });

  // ---- Correction examples stats API ----
  router.get('/api/corrections/stats', async (_req, res) => {
    try {
      const { rows: categoryCounts } = await pool.query(
        `SELECT category, COUNT(*) as count
         FROM correction_examples
         GROUP BY category
         ORDER BY count DESC`
      );

      const { rows: [totals] } = await pool.query(
        `SELECT COUNT(*) as total FROM correction_examples`
      );

      res.json({
        category_counts: categoryCounts,
        total: parseInt(totals.total, 10),
      });
    } catch (err) {
      log.error({ err }, 'Correction stats error');
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
      log.error({ err }, 'Browse stats error');
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
      log.error({ err }, 'Browse thoughts error');
      res.status(500).json({ error: 'Internal error' });
    }
  });

  // ---- Health stats API ----
  router.get('/api/health/stats', async (_req, res) => {
    try {
      // Queue status counts
      const { rows: statusCounts } = await pool.query(
        `SELECT status, COUNT(*) as count FROM queue GROUP BY status`
      );

      // Extraction gaps: parent thoughts with no metadata (no embedding = not processed)
      const { rows: [gapRow] } = await pool.query(
        `SELECT COUNT(*) as count FROM thoughts
         WHERE parent_id IS NULL AND embedding IS NULL AND source != 'manual'`
      );

      // Recent failed items
      const { rows: failedItems } = await pool.query(
        `SELECT id, source, source_id, error, attempts, created_at, processed_at
         FROM queue
         WHERE status = 'failed'
         ORDER BY COALESCE(processed_at, created_at) DESC
         LIMIT 20`
      );

      // Pending retries in backoff
      const { rows: pendingRetries } = await pool.query(
        `SELECT id, source, source_id, error, attempts, retry_after, created_at
         FROM queue
         WHERE status = 'pending' AND retry_after IS NOT NULL AND retry_after > NOW()
         ORDER BY retry_after ASC
         LIMIT 20`
      );

      // Ollama availability check
      let ollamaAvailable = false;
      try {
        const ctrl = new AbortController();
        const timeout = setTimeout(() => ctrl.abort(), 3000);
        const resp = await fetch(`${config.ollamaBaseUrl}/api/tags`, { signal: ctrl.signal });
        ollamaAvailable = resp.ok;
        clearTimeout(timeout);
      } catch {
        ollamaAvailable = false;
      }

      const counts: Record<string, number> = {};
      for (const row of statusCounts) {
        counts[row.status] = parseInt(row.count, 10);
      }

      res.json({
        queue: {
          pending: counts['pending'] || 0,
          processing: counts['processing'] || 0,
          completed: counts['completed'] || 0,
          failed: counts['failed'] || 0,
        },
        extraction_gaps: parseInt(gapRow.count, 10),
        failed_items: failedItems,
        pending_retries: pendingRetries,
        ollama_available: ollamaAvailable,
      });
    } catch (err) {
      log.error({ err }, 'Health stats error');
      res.status(500).json({ error: 'Internal error' });
    }
  });

  // ---- Retry all failed queue items ----
  router.post('/api/health/retry-all', async (_req, res) => {
    try {
      const { rowCount } = await pool.query(
        `UPDATE queue SET status = 'pending', error = NULL, retry_after = NULL, processed_at = NULL
         WHERE status = 'failed'`
      );
      res.json({ ok: true, count: rowCount });
    } catch (err) {
      log.error({ err }, 'Retry all error');
      res.status(500).json({ error: 'Internal error' });
    }
  });

  // ---- Retry single failed queue item ----
  router.post('/api/health/retry/:id', async (req, res) => {
    try {
      const { rowCount } = await pool.query(
        `UPDATE queue SET status = 'pending', error = NULL, retry_after = NULL, processed_at = NULL
         WHERE id = $1 AND status = 'failed'`,
        [req.params.id]
      );
      if (rowCount === 0) {
        res.status(404).json({ error: 'Item not found or not in failed state' });
        return;
      }
      res.json({ ok: true });
    } catch (err) {
      log.error({ err }, 'Retry error');
      res.status(500).json({ error: 'Internal error' });
    }
  });

  // ---- Health detail: items for a specific queue status ----
  router.get('/api/health/detail/:category', async (req, res) => {
    try {
      const { category } = req.params;
      const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
      const offset = parseInt(req.query.offset as string) || 0;

      if (category === 'extraction_gaps') {
        const { rows } = await pool.query(
          `SELECT id, source, thought_type, LEFT(content, 200) as content_preview, created_at
           FROM thoughts
           WHERE parent_id IS NULL AND embedding IS NULL AND source != 'manual'
           ORDER BY created_at DESC
           LIMIT $1 OFFSET $2`,
          [limit, offset]
        );
        res.json({ items: rows, category });
        return;
      }

      const validStatuses = ['pending', 'processing', 'completed', 'failed'];
      if (!validStatuses.includes(category)) {
        res.status(400).json({ error: 'Invalid category. Use: pending, processing, completed, failed, extraction_gaps' });
        return;
      }

      const { rows } = await pool.query(
        `SELECT id, source, source_id, LEFT(content, 200) as content_preview,
                error, attempts, created_at, processed_at, retry_after
         FROM queue
         WHERE status = $1
         ORDER BY COALESCE(processed_at, created_at) DESC
         LIMIT $2 OFFSET $3`,
        [category, limit, offset]
      );
      res.json({ items: rows, category });
    } catch (err) {
      log.error({ err }, 'Health detail error');
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

      logAudit(pool, {
        action: 'content_ingested',
        resourceType: 'queue',
        resourceId: row.id,
        metadata: { source: 'manual', contentLength: content.length },
      });

      res.json({ id: row.id, status: 'queued' });
    } catch (err) {
      log.error({ err }, 'Ingest error');
      res.status(500).json({ error: 'Internal error' });
    }
  });

  // ---- File upload ingest ----
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 20 * 1024 * 1024 },
  });

  router.post('/api/ingest/file', upload.single('file'), async (req, res) => {
    try {
      if (!req.file) {
        res.status(400).json({ error: 'No file provided' });
        return;
      }

      const parsed = await parseFile(req.file.buffer, req.file.originalname, req.file.mimetype);
      let text = parsed.text.trim();

      if (!text) {
        res.status(400).json({ error: 'No text content extracted from file' });
        return;
      }

      // Prepend context note if provided
      const contextNote = (req.body?.context_note || '').trim();
      if (contextNote) {
        text = `[Context: ${contextNote}]\n\n${text}`;
      }

      // Save raw file for future reprocessing (best-effort)
      const fileId = crypto.randomUUID();
      const ext = path.extname(req.file.originalname).slice(1).toLowerCase();
      const rawFilePath = path.join(config.rawFilesDir, `${fileId}.${ext}`);
      try {
        await fs.promises.writeFile(rawFilePath, req.file.buffer);
      } catch (err) {
        log.error({ err }, 'Failed to save raw file');
      }

      const meta: Record<string, unknown> = {
        title: parsed.title || req.file.originalname,
        file_type: ext,
        original_filename: req.file.originalname,
        file_size: req.file.size,
        raw_file_path: rawFilePath,
        thought_type: req.body?.category || 'document',
      };

      if (parsed.pageCount) meta.page_count = parsed.pageCount;
      if (parsed.author) meta.author = parsed.author;
      if (parsed.creationDate) meta.creation_date = parsed.creationDate;
      if (parsed.keywords) meta.keywords = parsed.keywords;
      if (contextNote) meta.context_note = contextNote;

      const attribution = (req.body?.attribution || '').trim();
      if (attribution) meta.attribution = attribution;

      if (req.body?.related_entity_ids) {
        try {
          meta.related_entity_ids = JSON.parse(req.body.related_entity_ids);
        } catch { /* ignore bad JSON */ }
      }

      const { rows: [row] } = await pool.query(
        `INSERT INTO queue (content, source, source_meta) VALUES ($1, 'manual', $2) RETURNING id`,
        [text, JSON.stringify(meta)]
      );

      logAudit(pool, {
        action: 'file_uploaded',
        resourceType: 'queue',
        resourceId: row.id,
        metadata: { title: meta.title, pageCount: parsed.pageCount, textLength: text.length },
      });

      res.json({
        id: row.id,
        status: 'queued',
        title: meta.title,
        pageCount: parsed.pageCount,
        textLength: text.length,
      });
    } catch (err) {
      const message = (err as Error).message || 'Failed to parse file';
      // Parser errors (scanned PDF, magic byte mismatch, unsupported type) → 400
      if (message.includes('scanned') || message.includes('magic byte') || message.includes('Unsupported')) {
        res.status(400).json({ error: message });
      } else {
        log.error({ err }, 'File ingest error');
        res.status(500).json({ error: sanitizeError(err) });
      }
    }
  });

  // Handle multer size limit errors
  router.use('/api/ingest/file', (err: any, _req: any, res: any, next: any) => {
    if (err?.code === 'LIMIT_FILE_SIZE') {
      res.status(413).json({ error: 'File too large (max 20MB)' });
      return;
    }
    next(err);
  });

  // ---- Audio transcription ----
  const AUDIO_EXTENSIONS = new Set(['m4a', 'mp3', 'wav', 'ogg', 'flac', 'webm', 'mp4', 'aac', 'wma']);
  const audioUpload = multer({
    storage: multer.diskStorage({
      destination: config.transcribeDir,
      filename: (_req, file, cb) => {
        const ext = path.extname(file.originalname).slice(1).toLowerCase();
        cb(null, `${crypto.randomUUID()}.${ext}`);
      },
    }),
    limits: { fileSize: 200 * 1024 * 1024 }, // 200MB
    fileFilter: (_req, file, cb) => {
      const ext = path.extname(file.originalname).slice(1).toLowerCase();
      if (!AUDIO_EXTENSIONS.has(ext)) {
        cb(new Error(`Unsupported audio format: .${ext}`));
        return;
      }
      cb(null, true);
    },
  });

  router.post('/api/transcribe', audioUpload.single('file'), async (req, res) => {
    try {
      if (!req.file) {
        res.status(400).json({ error: 'No audio file provided' });
        return;
      }

      const job = createJob(
        crypto.randomUUID(),
        req.file.path,
        req.file.originalname,
        req.file.size,
      );

      logAudit(pool, {
        action: 'transcription_started',
        resourceType: 'transcription',
        resourceId: job.id,
        metadata: { filename: req.file!.originalname, size: req.file!.size },
      });

      // Start transcription in background (don't await)
      runTranscription(job.id, config).catch(err => {
        log.error({ err }, 'Transcription background error');
      });

      res.json({ id: job.id, status: job.status });
    } catch (err) {
      log.error({ err }, 'Transcribe upload error');
      res.status(500).json({ error: sanitizeError(err) });
    }
  });

  // Handle audio upload errors (file size, format)
  router.use('/api/transcribe', (err: any, _req: any, res: any, next: any) => {
    if (err?.code === 'LIMIT_FILE_SIZE') {
      res.status(413).json({ error: 'File too large (max 200MB)' });
      return;
    }
    if (err?.message?.includes('Unsupported audio format')) {
      res.status(400).json({ error: err.message });
      return;
    }
    next(err);
  });

  router.get('/api/transcribe/:id', async (req, res) => {
    const job = getJob(req.params.id);
    if (!job) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }
    res.json(job);
  });

  router.get('/api/transcribe', async (_req, res) => {
    res.json(listJobs().slice(0, 20));
  });

  router.post('/api/transcribe/:id/save', async (req, res) => {
    try {
      const job = getJob(req.params.id);
      if (!job) {
        res.status(404).json({ error: 'Job not found' });
        return;
      }
      if (job.status !== 'completed' || !job.result) {
        res.status(400).json({ error: 'Transcription not yet completed' });
        return;
      }
      if (job.savedToQueue) {
        res.json({ id: job.queueId, status: 'already_saved' });
        return;
      }

      let content = job.result.text;
      const contextNote = (req.body?.context_note || '').trim();
      if (contextNote) {
        content = `[Context: ${contextNote}]\n\n${content}`;
      }

      const meta: Record<string, unknown> = {
        title: req.body?.title || job.originalFilename.replace(/\.[^.]+$/, ''),
        thought_type: 'meeting_transcript',
        source_type: 'audio_transcription',
        original_filename: job.originalFilename,
        audio_duration: job.result.duration,
        language: job.result.language,
        segment_count: job.result.segments.length,
        whisper_model: config.whisperModel,
      };
      if (job.result.summary) meta.summary_hint = job.result.summary;
      if (contextNote) meta.context_note = contextNote;

      const attribution = (req.body?.attribution || '').trim();
      if (attribution) meta.attribution = attribution;

      const { rows: [row] } = await pool.query(
        `INSERT INTO queue (content, source, source_meta) VALUES ($1, 'transcription', $2) RETURNING id`,
        [content, JSON.stringify(meta)]
      );

      updateJob(job.id, { savedToQueue: true, queueId: row.id });

      logAudit(pool, {
        action: 'transcription_saved',
        resourceType: 'queue',
        resourceId: row.id,
        metadata: { jobId: job.id, title: meta.title },
      });

      res.json({ id: row.id, status: 'queued' });
    } catch (err) {
      log.error({ err }, 'Transcribe save error');
      res.status(500).json({ error: 'Internal error' });
    }
  });

  router.post('/api/transcribe/:id/speakers', async (req, res) => {
    try {
      const job = getJob(req.params.id);
      if (!job) {
        res.status(404).json({ error: 'Job not found' });
        return;
      }
      if (job.status !== 'completed' || !job.result) {
        res.status(400).json({ error: 'Transcription not yet completed' });
        return;
      }

      const speakers = req.body?.speakers;
      if (!speakers || typeof speakers !== 'object' || Object.keys(speakers).length === 0) {
        res.status(400).json({ error: 'speakers map is required (e.g., { "SPEAKER_00": "Daniel" })' });
        return;
      }

      // Store the original (unmapped) data if not already stored
      if (!job.result._originalText) {
        (job.result as any)._originalText = job.result.text;
        (job.result as any)._originalSegments = job.result.segments.map(s => ({ ...s }));
      }

      // Apply speaker names to text and segments
      const original = (job.result as any)._originalText as string;
      const originalSegments = (job.result as any)._originalSegments as typeof job.result.segments;
      const { text, segments } = applySpeakerNames(original, originalSegments, speakers);

      updateJob(job.id, {
        speakerMap: speakers,
        result: { ...job.result, text, segments },
      });

      res.json({ ok: true, speakerMap: speakers });
    } catch (err) {
      log.error({ err }, 'Speaker mapping error');
      res.status(500).json({ error: 'Internal error' });
    }
  });

  router.post('/api/transcribe/:id/resummarize', async (req, res) => {
    try {
      const job = getJob(req.params.id);
      if (!job) {
        res.status(404).json({ error: 'Job not found' });
        return;
      }
      if (job.status !== 'completed' || !job.result) {
        res.status(400).json({ error: 'Transcription not yet completed' });
        return;
      }

      const summary = await generateSummary(job.result.text, config, job.speakerMap);
      updateJob(job.id, {
        result: { ...job.result, summary },
      });

      res.json({ ok: true, summary });
    } catch (err) {
      log.error({ err }, 'Resummarize error');
      res.status(500).json({ error: 'Summary generation failed' });
    }
  });

  router.get('/api/transcribe/:id/download', async (req, res) => {
    const job = getJob(req.params.id);
    if (!job || !job.result) {
      res.status(404).json({ error: 'Transcription not found or not completed' });
      return;
    }

    const format = (req.query.format as string) || 'txt';
    const basename = job.originalFilename.replace(/\.[^.]+$/, '');

    if (format === 'srt') {
      res.setHeader('Content-Type', 'text/srt');
      res.setHeader('Content-Disposition', `attachment; filename="${basename}.srt"`);
      res.send(formatAsSrt(job.result.segments));
    } else if (format === 'json') {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', `attachment; filename="${basename}.json"`);
      res.json(job.result);
    } else {
      // txt: transcript + summary
      res.setHeader('Content-Type', 'text/plain');
      res.setHeader('Content-Disposition', `attachment; filename="${basename}.txt"`);
      let text = job.result.text;
      if (job.result.summary) {
        text = `SUMMARY\n${'='.repeat(40)}\n${job.result.summary}\n\nTRANSCRIPT\n${'='.repeat(40)}\n${text}`;
      }
      res.send(text);
    }
  });

  // ---- Community API ----
  router.get('/api/communities', async (req, res) => {
    try {
      const level = parseInt(req.query.level as string, 10) || 0;
      const limit = Math.min(parseInt(req.query.limit as string, 10) || 50, 200);
      const sort = req.query.sort === 'recent' ? 'c.updated_at DESC' : 'c.member_count DESC';

      const { rows: communities } = await pool.query(
        `SELECT c.id, c.level, c.title, c.summary, c.full_report, c.member_count,
                c.created_at, c.updated_at
         FROM communities c
         WHERE c.level = $1
         ORDER BY ${sort}
         LIMIT $2`,
        [level, limit]
      );

      // Fetch members for each community
      const result = [];
      for (const community of communities) {
        const { rows: members } = await pool.query(
          `SELECT e.id, e.name, e.entity_type, e.mention_count
           FROM entity_communities ec
           JOIN entities e ON e.id = ec.entity_id
           WHERE ec.community_id = $1
           ORDER BY e.mention_count DESC`,
          [community.id]
        );
        result.push({ ...community, members });
      }

      const { rows: [totalRow] } = await pool.query(
        `SELECT COUNT(*) as total FROM communities WHERE level = $1`,
        [level]
      );

      res.json({
        communities: result,
        total: parseInt(totalRow.total, 10),
      });
    } catch (err) {
      log.error({ err }, 'Communities list error');
      res.status(500).json({ error: 'Internal error' });
    }
  });

  router.get('/api/communities/:id', async (req, res) => {
    try {
      const { rows: [community] } = await pool.query(
        `SELECT id, level, title, summary, full_report, member_count, created_at, updated_at
         FROM communities WHERE id = $1`,
        [req.params.id]
      );

      if (!community) {
        res.status(404).json({ error: 'Community not found' });
        return;
      }

      const { rows: members } = await pool.query(
        `SELECT e.id, e.name, e.entity_type, e.mention_count, e.profile_summary
         FROM entity_communities ec
         JOIN entities e ON e.id = ec.entity_id
         WHERE ec.community_id = $1
         ORDER BY e.mention_count DESC`,
        [community.id]
      );

      const memberIds = members.map((m: { id: string }) => m.id);
      const { rows: relationships } = memberIds.length > 0
        ? await pool.query(
            `SELECT er.description, er.weight, s.name as source_name, t.name as target_name
             FROM entity_relationships er
             JOIN entities s ON s.id = er.source_id
             JOIN entities t ON t.id = er.target_id
             WHERE er.source_id = ANY($1) AND er.target_id = ANY($1)
               AND er.description IS NOT NULL AND er.invalid_at IS NULL
             ORDER BY er.weight DESC`,
            [memberIds]
          )
        : { rows: [] };

      res.json({ ...community, members, relationships });
    } catch (err) {
      log.error({ err }, 'Community detail error');
      res.status(500).json({ error: 'Internal error' });
    }
  });

  router.post('/api/communities/refresh', async (_req, res) => {
    try {
      const { detectCommunities } = await import('../processor/community-detector.js');
      const result = await detectCommunities(pool);
      res.json({ ok: true, ...result });
    } catch (err) {
      log.error({ err }, 'Community refresh error');
      res.status(500).json({ error: 'Refresh failed' });
    }
  });

  // ---- Graph API: neighborhood ----
  // ?depth=1|2  &min_weight=N (default 2)  &limit=N (max neighbor nodes, default 50)
  router.get('/api/graph/:entityId', async (req, res) => {
    try {
      const entityId = req.params.entityId;
      const depth = Math.min(parseInt(req.query.depth as string, 10) || 1, 2);
      const minWeight = Math.max(parseInt(req.query.min_weight as string, 10) || 2, 1);
      const limit = Math.min(parseInt(req.query.limit as string, 10) || 50, 200);

      // Verify entity exists
      const { rows: [entity] } = await pool.query(
        `SELECT id FROM entities WHERE id = $1`, [entityId]
      );
      if (!entity) {
        res.status(404).json({ error: 'Entity not found' });
        return;
      }

      let edgeRows: any[];
      if (depth === 1) {
        // Get top-N neighbors by weight, then all edges among them
        const { rows } = await pool.query(
          `WITH top_neighbors AS (
             SELECT DISTINCT CASE WHEN source_id = $1 THEN target_id ELSE source_id END AS neighbor_id,
                    MAX(weight) as max_weight
             FROM entity_relationships
             WHERE (source_id = $1 OR target_id = $1) AND invalid_at IS NULL AND weight >= $2
             GROUP BY neighbor_id
             ORDER BY max_weight DESC
             LIMIT $3
           ),
           all_ids AS (
             SELECT $1::uuid AS id UNION SELECT neighbor_id FROM top_neighbors
           )
           SELECT er.id, er.source_id, er.target_id, er.weight, er.description
           FROM entity_relationships er
           WHERE er.source_id IN (SELECT id FROM all_ids)
             AND er.target_id IN (SELECT id FROM all_ids)
             AND er.invalid_at IS NULL AND er.weight >= $2
           ORDER BY er.weight DESC`,
          [entityId, minWeight, limit]
        );
        edgeRows = rows;
      } else {
        // 2-hop: top-N 1-hop neighbors, then their edges among themselves
        const { rows } = await pool.query(
          `WITH hop1 AS (
             SELECT DISTINCT CASE WHEN source_id = $1 THEN target_id ELSE source_id END AS entity_id,
                    MAX(weight) as max_weight
             FROM entity_relationships
             WHERE (source_id = $1 OR target_id = $1) AND invalid_at IS NULL AND weight >= $2
             GROUP BY entity_id
             ORDER BY max_weight DESC
             LIMIT $3
           ),
           all_ids AS (
             SELECT $1::uuid AS entity_id
             UNION SELECT entity_id FROM hop1
           )
           SELECT er.id, er.source_id, er.target_id, er.weight, er.description
           FROM entity_relationships er
           WHERE (er.source_id IN (SELECT entity_id FROM all_ids)
              OR er.target_id IN (SELECT entity_id FROM all_ids))
             AND er.invalid_at IS NULL AND er.weight >= $2
           ORDER BY er.weight DESC
           LIMIT 500`,
          [entityId, minWeight, limit]
        );
        edgeRows = rows;
      }

      // Collect unique node IDs
      const nodeIds = new Set<string>([entityId]);
      for (const e of edgeRows) {
        nodeIds.add(e.source_id);
        nodeIds.add(e.target_id);
      }

      const nodeIdArr = [...nodeIds];
      const { rows: nodeRows } = nodeIdArr.length > 0
        ? await pool.query(
            `SELECT e.id, e.name, e.entity_type, e.mention_count, e.profile_summary,
                    ec.community_id
             FROM entities e
             LEFT JOIN entity_communities ec ON ec.entity_id = e.id AND ec.level = 0
             WHERE e.id = ANY($1)`,
            [nodeIdArr]
          )
        : { rows: [] };

      res.json({
        center: entityId,
        nodes: nodeRows,
        edges: edgeRows.map((e: any) => ({
          id: e.id, source: e.source_id, target: e.target_id,
          weight: e.weight, description: e.description,
        })),
      });
    } catch (err) {
      log.error({ err }, 'Graph neighborhood error');
      res.status(500).json({ error: 'Internal error' });
    }
  });

  // ---- Graph API: full graph ----
  // ?min_weight=N (default 2)
  router.get('/api/graph', async (req, res) => {
    try {
      const minWeight = Math.max(parseInt(req.query.min_weight as string, 10) || 2, 1);

      // Only include entities that participate in edges above threshold
      const { rows: edgeRows } = await pool.query(
        `SELECT er.id, er.source_id, er.target_id, er.weight, er.description
         FROM entity_relationships er
         WHERE er.invalid_at IS NULL AND er.weight >= $1
         ORDER BY er.weight DESC`,
        [minWeight]
      );

      // Collect node IDs from edges (skip orphan entities)
      const nodeIds = new Set<string>();
      for (const e of edgeRows) {
        nodeIds.add(e.source_id);
        nodeIds.add(e.target_id);
      }

      const nodeIdArr = [...nodeIds];
      const { rows: nodeRows } = nodeIdArr.length > 0
        ? await pool.query(
            `SELECT e.id, e.name, e.entity_type, e.mention_count, e.profile_summary,
                    ec.community_id
             FROM entities e
             LEFT JOIN entity_communities ec ON ec.entity_id = e.id AND ec.level = 0
             WHERE e.id = ANY($1)`,
            [nodeIdArr]
          )
        : { rows: [] };

      res.json({
        center: null,
        nodes: nodeRows,
        edges: edgeRows.map((e: any) => ({
          id: e.id, source: e.source_id, target: e.target_id,
          weight: e.weight, description: e.description,
        })),
      });
    } catch (err) {
      log.error({ err }, 'Full graph error');
      res.status(500).json({ error: 'Internal error' });
    }
  });

  // ---- Entity detail API (for graph panel) ----
  router.get('/api/entity/:entityId/detail', async (req, res) => {
    try {
      const entityId = req.params.entityId;

      const { rows: [entity] } = await pool.query(
        `SELECT id, name, entity_type, canonical_name, aliases,
                profile_summary, mention_count, last_seen_at, metadata,
                created_at, updated_at
         FROM entities WHERE id = $1`,
        [entityId]
      );
      if (!entity) {
        res.status(404).json({ error: 'Entity not found' });
        return;
      }

      // Recent thoughts linked to this entity
      const { rows: recentThoughts } = await pool.query(
        `SELECT t.id, t.summary, LEFT(t.content, 200) as content_preview,
                t.thought_type, t.source, te.relationship, t.created_at
         FROM thought_entities te
         JOIN thoughts t ON t.id = te.thought_id
         WHERE te.entity_id = $1
         ORDER BY t.created_at DESC
         LIMIT 10`,
        [entityId]
      );

      // Connected entities (co-occurrence + explicit edges)
      const { rows: connected } = await pool.query(
        `SELECT e.id, e.name, e.entity_type,
                COALESCE(co.shared_thought_count, 0)::int as shared_thought_count,
                COALESCE(er.weight, 0)::int as relationship_weight,
                er.description as relationship_description
         FROM (
           SELECT te2.entity_id, COUNT(*) as shared_thought_count
           FROM thought_entities te1
           JOIN thought_entities te2 ON te1.thought_id = te2.thought_id AND te1.entity_id != te2.entity_id
           WHERE te1.entity_id = $1
           GROUP BY te2.entity_id
         ) co
         FULL OUTER JOIN (
           SELECT
             CASE WHEN source_id = $1 THEN target_id ELSE source_id END as entity_id,
             description, weight
           FROM entity_relationships
           WHERE (source_id = $1 OR target_id = $1) AND invalid_at IS NULL
         ) er ON co.entity_id = er.entity_id
         JOIN entities e ON e.id = COALESCE(co.entity_id, er.entity_id)
         ORDER BY COALESCE(er.weight, 0) + COALESCE(co.shared_thought_count, 0) DESC
         LIMIT 30`,
        [entityId]
      );

      // Communities
      const { rows: communities } = await pool.query(
        `SELECT c.id, c.title
         FROM entity_communities ec
         JOIN communities c ON c.id = ec.community_id
         WHERE ec.entity_id = $1`,
        [entityId]
      );

      res.json({
        entity,
        recent_thoughts: recentThoughts,
        connected_entities: connected,
        communities,
      });
    } catch (err) {
      log.error({ err }, 'Entity detail error');
      res.status(500).json({ error: 'Internal error' });
    }
  });

  // ---- Entity autocomplete search ----
  router.get('/api/entities/search', async (req, res) => {
    try {
      const q = (req.query.q as string || '').trim();
      if (q.length < 2) {
        res.json([]);
        return;
      }
      const { rows } = await pool.query(
        `SELECT id, name, entity_type FROM entities
         WHERE name ILIKE $1 AND mention_count > 0
         ORDER BY mention_count DESC LIMIT 10`,
        [`%${q}%`]
      );
      res.json(rows);
    } catch (err) {
      log.error({ err }, 'Entity search error');
      res.status(500).json({ error: 'Internal error' });
    }
  });

  // ---- Chat Traces API ----

  router.get('/api/chat-traces', async (req, res) => {
    try {
      const limit = Math.min(parseInt(req.query.limit as string, 10) || 50, 200);
      const offset = parseInt(req.query.offset as string, 10) || 0;
      const conversationId = req.query.conversation_id as string | undefined;

      const conditions = [`m.role = 'assistant'`, `m.context_data IS NOT NULL`];
      const params: (string | number)[] = [];
      let paramIdx = 1;

      if (conversationId) {
        conditions.push(`m.conversation_id = $${paramIdx}`);
        params.push(conversationId);
        paramIdx++;
      }

      const whereClause = 'WHERE ' + conditions.join(' AND ');

      const { rows: [countRow] } = await pool.query(
        `SELECT COUNT(*) as total FROM chat_messages m ${whereClause}`,
        params,
      );

      const { rows } = await pool.query(
        `SELECT
           m.id,
           m.conversation_id,
           c.title as conversation_title,
           prev.content as user_message,
           LEFT(m.content, 200) as assistant_excerpt,
           m.context_data->'intent'->>'type' as intent_type,
           (m.context_data->'intent'->>'confidence')::float as intent_confidence,
           m.context_data->'intent'->>'was_fast_path' as intent_fast_path,
           m.context_data->'intent'->>'reasoning' as intent_reasoning,
           jsonb_array_length(COALESCE(m.context_data->'sources', '[]'::jsonb)) as source_count,
           jsonb_array_length(COALESCE(m.context_data->'facts', '[]'::jsonb)) as fact_count,
           (m.context_data->'timing'->>'total_ms')::int as total_ms,
           (m.context_data->'timing'->>'intent_ms')::int as intent_ms,
           (m.context_data->'timing'->>'search_ms')::int as search_ms,
           (m.context_data->'timing'->>'llm_ms')::int as llm_ms,
           m.created_at
         FROM chat_messages m
         JOIN conversations c ON c.id = m.conversation_id
         LEFT JOIN LATERAL (
           SELECT content FROM chat_messages
           WHERE conversation_id = m.conversation_id AND role = 'user' AND created_at < m.created_at
           ORDER BY created_at DESC LIMIT 1
         ) prev ON true
         ${whereClause}
         ORDER BY m.created_at DESC
         LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
        [...params, limit, offset],
      );

      res.json({ traces: rows, total: parseInt(countRow.total, 10), limit, offset });
    } catch (err) {
      log.error({ err }, 'Chat traces list error');
      res.status(500).json({ error: 'Internal error' });
    }
  });

  router.get('/api/chat-traces/:messageId', async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT
           m.id,
           m.conversation_id,
           m.content as assistant_response,
           m.context_data,
           m.created_at,
           prev.content as user_message
         FROM chat_messages m
         LEFT JOIN LATERAL (
           SELECT content FROM chat_messages
           WHERE conversation_id = m.conversation_id AND role = 'user' AND created_at < m.created_at
           ORDER BY created_at DESC LIMIT 1
         ) prev ON true
         WHERE m.id = $1 AND m.role = 'assistant'`,
        [req.params.messageId],
      );

      if (rows.length === 0) {
        res.status(404).json({ error: 'Trace not found' });
        return;
      }

      res.json(rows[0]);
    } catch (err) {
      log.error({ err }, 'Chat trace detail error');
      res.status(500).json({ error: 'Internal error' });
    }
  });

  // ---- Deals API ----

  router.get('/api/deals', async (req, res) => {
    try {
      const limit = Math.min(parseInt(req.query.limit as string, 10) || 50, 200);
      const offset = parseInt(req.query.offset as string, 10) || 0;

      const { rows: [countRow] } = await pool.query(
        `SELECT COUNT(*) as total FROM thoughts WHERE thought_type = 'deal' AND source = 'hubspot' AND parent_id IS NULL`,
      );

      const { rows } = await pool.query(
        `SELECT t.id, t.content, t.source_meta, t.created_at, t.updated_at
         FROM thoughts t
         WHERE t.thought_type = 'deal' AND t.source = 'hubspot' AND t.parent_id IS NULL
         ORDER BY t.created_at DESC
         LIMIT $1 OFFSET $2`,
        [limit, offset],
      );

      const deals = rows.map((r: any) => {
        const meta = r.source_meta ?? {};
        // Extract deal name from content (first line: "HubSpot Deal: <name>")
        const nameMatch = r.content?.match(/^HubSpot Deal:\s*(.+)/m);
        const dealName = nameMatch?.[1]?.trim() || 'Unnamed Deal';
        // Extract stage
        const stageMatch = r.content?.match(/^Stage:\s*(.+)/m);
        const stage = stageMatch?.[1]?.trim() || null;
        // Extract owner
        const ownerMatch = r.content?.match(/^Owner:\s*(.+)/m);
        const owner = ownerMatch?.[1]?.trim() || null;

        return {
          id: r.id,
          deal_name: dealName,
          company_name: meta.directMetadata?.companies?.[0] ?? null,
          stage,
          owner,
          contacts: meta.directMetadata?.people ?? [],
          synthesis: meta.deal_synthesis ?? null,
          source_meta: meta,
          created_at: r.created_at,
          updated_at: r.updated_at,
        };
      });

      res.json({ deals, total: parseInt(countRow.total, 10), limit, offset });
    } catch (err) {
      log.error({ err }, 'Deals list error');
      res.status(500).json({ error: 'Internal error' });
    }
  });

  router.get('/api/deals/:id', async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT t.id, t.content, t.source_meta, t.created_at, t.updated_at
         FROM thoughts t
         WHERE t.id = $1 AND t.thought_type = 'deal'`,
        [req.params.id],
      );

      if (rows.length === 0) {
        res.status(404).json({ error: 'Deal not found' });
        return;
      }

      const deal = rows[0];
      const synthesis = deal.source_meta?.deal_synthesis ?? null;

      // Fetch related thoughts if synthesis has source IDs
      let relatedThoughts: any[] = [];
      if (synthesis?.sources?.length > 0) {
        const { rows: related } = await pool.query(
          `SELECT id, LEFT(content, 300) as excerpt, summary, source, thought_type, created_at
           FROM thoughts
           WHERE id = ANY($1)
           ORDER BY created_at DESC`,
          [synthesis.sources],
        );
        relatedThoughts = related;
      }

      res.json({
        id: deal.id,
        content: deal.content,
        synthesis,
        related_thoughts: relatedThoughts,
        created_at: deal.created_at,
        updated_at: deal.updated_at,
      });
    } catch (err) {
      log.error({ err }, 'Deal detail error');
      res.status(500).json({ error: 'Internal error' });
    }
  });

  return router;
}
