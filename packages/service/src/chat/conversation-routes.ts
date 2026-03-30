import { Router } from 'express';
import express from 'express';
import type pg from 'pg';
import type { Config } from '../config.js';
import { buildContext } from './context-builder.js';
import { streamChat } from './ollama-stream.js';
import { SYSTEM_PROMPT } from './system-prompt.js';
import { acquireOllama, releaseOllama } from '../ollama-mutex.js';
import { createChildLogger } from '../logger.js';
import { sanitizeError } from '../errors.js';
import {
  CHAT_MAX_HISTORY_MESSAGES,
  CONVERSATION_TITLE_MAX_LENGTH,
  CONVERSATION_LIST_LIMIT,
} from '@danielbrain/shared';

function generateTitle(message: string): string {
  // Truncate at word boundary
  const trimmed = message.trim().replace(/\s+/g, ' ');
  if (trimmed.length <= CONVERSATION_TITLE_MAX_LENGTH) return trimmed;
  const cut = trimmed.slice(0, CONVERSATION_TITLE_MAX_LENGTH);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > 20 ? cut.slice(0, lastSpace) : cut) + '...';
}

export function createConversationRoutes(pool: pg.Pool, config: Config): Router {
  const log = createChildLogger('chat');
  const router = Router();
  router.use(express.json());

  // List conversations
  router.get('/', async (req, res) => {
    try {
      const projectId = req.query.project_id as string | undefined;
      const limit = Math.min(parseInt(req.query.limit as string, 10) || CONVERSATION_LIST_LIMIT, 100);

      let query = `SELECT id, title, project_id, created_at, updated_at
        FROM conversations WHERE is_deleted = FALSE`;
      const params: (string | number)[] = [];

      // Scope to current user if authenticated
      if (req.userContext) {
        params.push(req.userContext.userId);
        query += ` AND (user_id = $${params.length} OR user_id IS NULL)`;
      }

      if (projectId) {
        params.push(projectId);
        query += ` AND project_id = $${params.length}`;
      }

      params.push(limit);
      query += ` ORDER BY updated_at DESC LIMIT $${params.length}`;

      const { rows } = await pool.query(query, params);
      res.json(rows);
    } catch (err) {
      log.error({ err }, 'List conversations error');
      res.status(500).json({ error: 'Internal error' });
    }
  });

  // Create conversation
  router.post('/', async (req, res) => {
    try {
      const { title, project_id } = req.body;
      const { rows: [row] } = await pool.query(
        `INSERT INTO conversations (title, project_id, user_id)
         VALUES ($1, $2, $3)
         RETURNING id, title, project_id, created_at, updated_at`,
        [title || null, project_id || null, req.userContext?.userId ?? null],
      );
      res.json(row);
    } catch (err) {
      log.error({ err }, 'Create conversation error');
      res.status(500).json({ error: 'Internal error' });
    }
  });

  // Get messages for a conversation
  router.get('/:id/messages', async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT id, role, content, context_data, created_at
         FROM chat_messages
         WHERE conversation_id = $1
         ORDER BY created_at ASC`,
        [req.params.id],
      );
      res.json(rows);
    } catch (err) {
      log.error({ err }, 'Get messages error');
      res.status(500).json({ error: 'Internal error' });
    }
  });

  // Update conversation (rename, assign project)
  router.patch('/:id', async (req, res) => {
    try {
      const updates: string[] = [];
      const params: (string | null)[] = [];
      let idx = 1;

      if ('title' in req.body) {
        updates.push(`title = $${idx++}`);
        params.push(req.body.title);
      }
      if ('project_id' in req.body) {
        updates.push(`project_id = $${idx++}`);
        params.push(req.body.project_id);
      }

      if (updates.length === 0) {
        res.status(400).json({ error: 'No fields to update' });
        return;
      }

      params.push(req.params.id);
      const { rows } = await pool.query(
        `UPDATE conversations SET ${updates.join(', ')} WHERE id = $${idx} AND is_deleted = FALSE
         RETURNING id, title, project_id, created_at, updated_at`,
        params,
      );

      if (rows.length === 0) {
        res.status(404).json({ error: 'Conversation not found' });
        return;
      }
      res.json(rows[0]);
    } catch (err) {
      log.error({ err }, 'Update conversation error');
      res.status(500).json({ error: 'Internal error' });
    }
  });

  // Delete conversation (soft)
  router.delete('/:id', async (req, res) => {
    try {
      const { rowCount } = await pool.query(
        `UPDATE conversations SET is_deleted = TRUE WHERE id = $1 AND is_deleted = FALSE`,
        [req.params.id],
      );
      if (rowCount === 0) {
        res.status(404).json({ error: 'Conversation not found' });
        return;
      }
      res.json({ ok: true });
    } catch (err) {
      log.error({ err }, 'Delete conversation error');
      res.status(500).json({ error: 'Internal error' });
    }
  });

  // Send message in a conversation (SSE streaming)
  router.post('/:id/messages', async (req, res) => {
    const { message } = req.body;
    const conversationId = req.params.id;

    if (!message || typeof message !== 'string') {
      res.status(400).json({ error: 'message is required' });
      return;
    }

    // Verify conversation exists
    const { rows: convRows } = await pool.query(
      `SELECT id FROM conversations WHERE id = $1 AND is_deleted = FALSE`,
      [conversationId],
    );
    if (convRows.length === 0) {
      res.status(404).json({ error: 'Conversation not found' });
      return;
    }

    // Set SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    if (!acquireOllama('chat')) {
      res.write(`data: ${JSON.stringify({ error: 'LLM is busy. Please try again shortly.' })}\n\n`);
      res.end();
      return;
    }
    const totalStart = Date.now();
    try {
      // Load recent history for context (user message not yet persisted)
      const { rows: historyRows } = await pool.query(
        `SELECT role, content FROM chat_messages
         WHERE conversation_id = $1
         ORDER BY created_at DESC
         LIMIT $2`,
        [conversationId, CHAT_MAX_HISTORY_MESSAGES],
      );
      // Reverse to get chronological order (we fetched DESC), then append current message
      const history = [
        ...historyRows.reverse(),
        { role: 'user', content: message },
      ];

      // Build RAG context (with timeout so chat doesn't hang if Ollama is busy)
      let context: Awaited<ReturnType<typeof buildContext>>;
      try {
        const visTags = req.userContext?.visibilityTags?.length ? req.userContext.visibilityTags : null;
        const contextPromise = buildContext(message, pool, config, visTags);
        const timeoutPromise = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Context retrieval timed out — Ollama may be busy')), 90_000),
        );
        context = await Promise.race([contextPromise, timeoutPromise]);
      } catch (ctxErr) {
        log.error({ err: ctxErr }, 'Context build failed');
        // Fall back to no-context chat
        context = {
          contextText: '', sources: [], entities: [],
          trace: {
            intent: { type: 'general', confidence: 0, reasoning: 'Context build failed', reformulated_query: null, was_fast_path: false },
            search_params: { query: message, threshold: 0, limit: 0, days_back: null },
            thoughts: [], facts: [],
            crm: { triggered: false, record_count: 0 },
            timing: { intent_ms: 0, search_ms: 0 },
          },
        };
      }

      // Log retrieval results for debugging
      log.info({ sourceCount: context.sources.length, entityCount: context.entities.length }, 'Chat context built');

      // Send context metadata
      res.write(`data: ${JSON.stringify({ type: 'context', sources: context.sources, entities: context.entities })}\n\n`);

      // Build system prompt with context
      const systemContent = context.contextText
        ? `${SYSTEM_PROMPT}\n\n--- CONTEXT FROM KNOWLEDGE BASE ---\n${context.contextText}\n--- END CONTEXT ---`
        : SYSTEM_PROMPT;

      const messages = [
        { role: 'system' as const, content: systemContent },
        ...history.map((h: { role: string; content: string }) => ({
          role: h.role as 'user' | 'assistant',
          content: h.content,
        })),
      ];

      // Stream response
      const llmStart = Date.now();
      const { fullResponse } = await streamChat(messages, config.chatModel, config.ollamaBaseUrl, res);
      const llmMs = Date.now() - llmStart;
      const totalMs = Date.now() - totalStart;

      // On success: persist both user and assistant messages (idempotent — safe to retry on failure)
      await pool.query(
        `INSERT INTO chat_messages (conversation_id, role, content)
         VALUES ($1, 'user', $2)`,
        [conversationId, message],
      );

      if (fullResponse) {
        // Build full trace for audit — context_data carries both UI fields (sources/entities)
        // and the complete reasoning trace for the admin chat-traces page
        const contextData = {
          sources: context.sources,
          entities: context.entities,
          intent: context.trace.intent,
          search_params: context.trace.search_params,
          thoughts: context.trace.thoughts,
          facts: context.trace.facts,
          crm: context.trace.crm,
          context_text: context.contextText,
          system_prompt: systemContent,
          messages,
          timing: {
            ...context.trace.timing,
            llm_ms: llmMs,
            total_ms: totalMs,
          },
        };

        await pool.query(
          `INSERT INTO chat_messages (conversation_id, role, content, context_data)
           VALUES ($1, 'assistant', $2, $3)`,
          [conversationId, fullResponse, JSON.stringify(contextData)],
        );
      }

      // Auto-title if this is the first exchange (2 messages: user + assistant we just saved)
      const { rows: [countRow] } = await pool.query(
        `SELECT COUNT(*) as count FROM chat_messages WHERE conversation_id = $1`,
        [conversationId],
      );
      if (parseInt(countRow.count, 10) === 2) {
        const title = generateTitle(message);
        await pool.query(
          `UPDATE conversations SET title = $1 WHERE id = $2 AND title IS NULL`,
          [title, conversationId],
        );
      }

      // Update conversation timestamp
      await pool.query(
        `UPDATE conversations SET updated_at = NOW() WHERE id = $1`,
        [conversationId],
      );
    } catch (err) {
      log.error({ err }, 'Chat message error');
      if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify({ error: sanitizeError(err, 'Chat error') })}\n\n`);
        res.end();
      }
    } finally {
      releaseOllama('chat');
    }
  });

  return router;
}

export { generateTitle };
