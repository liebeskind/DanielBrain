import { Router } from 'express';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import type pg from 'pg';
import type { Config } from '../config.js';
import { buildContext } from './context-builder.js';
import { streamChat } from './ollama-stream.js';
import { CHAT_MAX_HISTORY_MESSAGES } from '@danielbrain/shared';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SYSTEM_PROMPT = `You are the DanielBrain assistant — an AI with access to a personal knowledge base containing thoughts, meeting notes, conversations, and entity profiles.

You help the user recall information, prepare for meetings, find action items, and explore connections in their knowledge graph.

When answering:
- Cite specific information from the provided context
- If the context doesn't contain relevant information, say so honestly
- Be concise and direct
- When referencing people or entities, include what you know about them from the context`;

export function createChatRoutes(pool: pg.Pool, config: Config): Router {
  const router = Router();

  // Serve static files
  router.use(express.static(path.join(__dirname, 'static')));

  // Chat message endpoint — streams SSE
  router.post('/api/message', express.json(), async (req, res) => {
    const { message, history } = req.body;

    if (!message || typeof message !== 'string') {
      res.status(400).json({ error: 'message is required' });
      return;
    }

    // Set SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    try {
      // Build RAG context from the brain
      const context = await buildContext(message, pool, config);

      // Send context metadata as first event (for source display in UI)
      res.write(`data: ${JSON.stringify({ type: 'context', sources: context.sources, entities: context.entities })}\n\n`);

      // Assemble messages for Ollama
      const systemContent = context.contextText
        ? `${SYSTEM_PROMPT}\n\n--- CONTEXT FROM KNOWLEDGE BASE ---\n${context.contextText}\n--- END CONTEXT ---`
        : SYSTEM_PROMPT;

      // Trim history to limit
      const trimmedHistory = Array.isArray(history)
        ? history.slice(-CHAT_MAX_HISTORY_MESSAGES)
        : [];

      const messages = [
        { role: 'system' as const, content: systemContent },
        ...trimmedHistory,
        { role: 'user' as const, content: message },
      ];

      // Stream response from Ollama
      await streamChat(messages, config.chatModel, config.ollamaBaseUrl, res);
    } catch (err) {
      console.error('Chat error:', err);
      if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify({ error: `Chat error: ${String(err)}` })}\n\n`);
        res.end();
      }
    }
  });

  return router;
}
