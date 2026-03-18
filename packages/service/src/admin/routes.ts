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
import { runTranscription, formatAsSrt } from '../transcribe/service.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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
      console.error('Integration stats error:', err);
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
        console.error('Fathom pull error:', err);
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
      console.error('Entity stats error:', err);
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
      console.error('Proposal stats error:', err);
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
      console.error('Correction stats error:', err);
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
      console.error('Health stats error:', err);
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
      console.error('Retry all error:', err);
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
      console.error('Retry error:', err);
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
        console.warn('Failed to save raw file:', (err as Error).message);
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
        console.error('File ingest error:', err);
        res.status(500).json({ error: message });
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

      // Start transcription in background (don't await)
      runTranscription(job.id, config).catch(err => {
        console.error('Transcription background error:', err);
      });

      res.json({ id: job.id, status: job.status });
    } catch (err) {
      console.error('Transcribe upload error:', err);
      res.status(500).json({ error: (err as Error).message });
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

      res.json({ id: row.id, status: 'queued' });
    } catch (err) {
      console.error('Transcribe save error:', err);
      res.status(500).json({ error: 'Internal error' });
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
      console.error('Entity search error:', err);
      res.status(500).json({ error: 'Internal error' });
    }
  });

  return router;
}
