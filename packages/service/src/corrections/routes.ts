import { Router } from 'express';
import type pg from 'pg';
import { createCorrectionExampleSchema, listCorrectionExamplesSchema } from '@danielbrain/shared';
import { createCorrectionExample, listCorrectionExamples, deleteCorrectionExample } from './store.js';
import { createChildLogger } from '../logger.js';

const log = createChildLogger('corrections');

export function createCorrectionRoutes(pool: pg.Pool): Router {
  const router = Router();

  // List correction examples
  router.get('/', async (req, res) => {
    try {
      const input = listCorrectionExamplesSchema.parse({
        category: req.query.category || undefined,
        entity_id: req.query.entity_id || undefined,
        tags: req.query.tags ? (req.query.tags as string).split(',') : undefined,
        limit: req.query.limit ? Number(req.query.limit) : undefined,
        offset: req.query.offset ? Number(req.query.offset) : undefined,
      });

      const result = await listCorrectionExamples(input, pool);
      res.json(result);
    } catch (err) {
      log.error({ err }, 'List corrections error');
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // Create correction example
  router.post('/', async (req, res) => {
    try {
      const input = createCorrectionExampleSchema.parse(req.body);
      const id = await createCorrectionExample(input, pool);
      res.status(201).json({ id });
    } catch (err) {
      log.error({ err }, 'Create correction error');
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // Delete correction example
  router.delete('/:id', async (req, res) => {
    try {
      const deleted = await deleteCorrectionExample(req.params.id, pool);
      if (!deleted) {
        res.status(404).json({ error: 'Correction example not found' });
        return;
      }
      res.json({ ok: true });
    } catch (err) {
      log.error({ err }, 'Delete correction error');
      res.status(500).json({ error: 'Internal error' });
    }
  });

  return router;
}
