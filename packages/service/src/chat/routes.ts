import { Router } from 'express';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import type pg from 'pg';
import type { Config } from '../config.js';
import { createConversationRoutes } from './conversation-routes.js';
import { createProjectRoutes } from './project-routes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createChatRoutes(pool: pg.Pool, config: Config): Router {
  const router = Router();

  // Serve static files
  router.use(express.static(path.join(__dirname, 'static')));

  // Conversation CRUD + message sending
  router.use('/api/conversations', createConversationRoutes(pool, config));

  // Project CRUD
  router.use('/api/projects', createProjectRoutes(pool));

  return router;
}
