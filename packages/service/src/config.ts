import { z } from 'zod';

const configSchema = z.object({
  databaseUrl: z.string().min(1),
  brainAccessKey: z.string().min(1),
  slackBotToken: z.string().min(1),
  slackSigningSecret: z.string().min(1),
  ollamaBaseUrl: z.string().default('http://localhost:11434'),
  embeddingModel: z.string().default('nomic-embed-text'),
  extractionModel: z.string().default('llama3.1:8b'),
  mcpPort: z.number().int().default(3000),
  pollIntervalMs: z.number().int().default(5000),
  batchSize: z.number().int().default(5),
  maxRetries: z.number().int().default(3),
});

export type Config = z.infer<typeof configSchema>;

export function loadConfig(): Config {
  return configSchema.parse({
    databaseUrl: process.env.DATABASE_URL,
    brainAccessKey: process.env.BRAIN_ACCESS_KEY,
    slackBotToken: process.env.SLACK_BOT_TOKEN,
    slackSigningSecret: process.env.SLACK_SIGNING_SECRET,
    ollamaBaseUrl: process.env.OLLAMA_BASE_URL || undefined,
    embeddingModel: process.env.EMBEDDING_MODEL || undefined,
    extractionModel: process.env.EXTRACTION_MODEL || undefined,
    mcpPort: process.env.MCP_PORT ? parseInt(process.env.MCP_PORT, 10) : undefined,
    pollIntervalMs: process.env.POLL_INTERVAL_MS ? parseInt(process.env.POLL_INTERVAL_MS, 10) : undefined,
    batchSize: process.env.BATCH_SIZE ? parseInt(process.env.BATCH_SIZE, 10) : undefined,
    maxRetries: process.env.MAX_RETRIES ? parseInt(process.env.MAX_RETRIES, 10) : undefined,
  });
}
