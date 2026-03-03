import type pg from 'pg';
import { processThought } from '../../processor/pipeline.js';

interface SaveThoughtInput {
  content: string;
  source: string;
}

interface PipelineConfig {
  ollamaBaseUrl: string;
  embeddingModel: string;
  extractionModel: string;
}

export async function handleSaveThought(
  input: SaveThoughtInput,
  pool: pg.Pool,
  config: PipelineConfig
) {
  return processThought(input.content, input.source, pool, config);
}
