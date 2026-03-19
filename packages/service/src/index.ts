import 'dotenv/config';
import fs from 'fs';
import https from 'https';
import path from 'path';
import express from 'express';
import pg from 'pg';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { loadConfig } from './config.js';
import { createMcpServer } from './mcp/server.js';
import { verifyAccessKey } from './auth.js';
import { verifySlackSignature } from './slack/verify.js';
import { handleSlackEvent } from './slack/webhook.js';
import { verifyTelegramSecret } from './telegram/verify.js';
import { handleTelegramUpdate } from './telegram/webhook.js';
import { pollQueue } from './processor/queue-poller.js';
import { refreshStaleProfiles } from './processor/profile-generator.js';
import {
  PROFILE_REFRESH_INTERVAL_MS,
  LINKEDIN_ENRICHMENT_INTERVAL_MS,
  RELATIONSHIP_DESCRIPTION_INTERVAL_MS,
  COMMUNITY_DETECTION_INTERVAL_MS,
  COMMUNITY_SUMMARY_INTERVAL_MS,
} from '@danielbrain/shared';
import { createProposalRoutes } from './proposals/routes.js';
import { createAdminRoutes } from './admin/routes.js';
import { createChatRoutes } from './chat/routes.js';
import { enrichLinkedInBatch } from './enrichers/linkedin.js';
import { verifyFathomSignature } from './fathom/verify.js';
import { handleFathomEvent } from './fathom/webhook.js';
import { createCorrectionRoutes } from './corrections/routes.js';
import { describeUndescribedRelationships } from './processor/relationship-describer.js';
import { acquireOllama, releaseOllama } from './ollama-mutex.js';
import { detectCommunities } from './processor/community-detector.js';
import { summarizeUnsummarizedCommunities } from './processor/community-summarizer.js';

const config = loadConfig();
const pool = new pg.Pool({ connectionString: config.databaseUrl });

const app = express();

// --- Ensure data directories exist ---
fs.mkdirSync(config.rawFilesDir, { recursive: true });
fs.mkdirSync(config.transcribeDir, { recursive: true });

// --- Health check ---
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// --- Slack webhook (optional — only if configured) ---
if (config.slackBotToken && config.slackSigningSecret) {
  app.post('/slack/events', express.raw({ type: '*/*' }), async (req, res) => {
    const body = req.body.toString();

    const valid = verifySlackSignature({
      signature: req.headers['x-slack-signature'] as string,
      timestamp: req.headers['x-slack-request-timestamp'] as string,
      body,
      signingSecret: config.slackSigningSecret!,
    });

    if (!valid) {
      res.status(401).json({ error: 'Invalid signature' });
      return;
    }

    try {
      const payload = JSON.parse(body);

      // Respond immediately for URL verification
      if (payload.type === 'url_verification') {
        res.json({ challenge: payload.challenge });
        return;
      }

      // Respond 200 immediately, process async
      res.json({ ok: true });

      await handleSlackEvent(payload, pool);
    } catch (err) {
      console.error('Slack webhook error:', err);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Internal error' });
      }
    }
  });
}

// --- Telegram webhook (optional — only if configured) ---
if (config.telegramBotToken && config.telegramWebhookSecret) {
  app.post('/telegram/updates', express.json(), async (req, res) => {
    const secretHeader = req.headers['x-telegram-bot-api-secret-token'] as string | undefined;

    if (!verifyTelegramSecret(secretHeader, config.telegramWebhookSecret!)) {
      res.status(401).json({ error: 'Invalid secret token' });
      return;
    }

    try {
      res.json({ ok: true });
      await handleTelegramUpdate(req.body, pool, config.telegramBotToken);
    } catch (err) {
      console.error('Telegram webhook error:', err);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Internal error' });
      }
    }
  });
}

// --- Fathom webhook (optional — only if configured) ---
if (config.fathomApiKey && config.fathomWebhookSecret) {
  app.post('/fathom/events', express.raw({ type: '*/*' }), async (req, res) => {
    const body = req.body.toString();

    const valid = verifyFathomSignature({
      webhookId: req.headers['webhook-id'] as string | undefined,
      webhookTimestamp: req.headers['webhook-timestamp'] as string | undefined,
      webhookSignature: req.headers['webhook-signature'] as string | undefined,
      body,
      secret: config.fathomWebhookSecret!,
    });

    if (!valid) {
      res.status(401).json({ error: 'Invalid signature' });
      return;
    }

    try {
      const meeting = JSON.parse(body);
      res.json({ ok: true });
      await handleFathomEvent(meeting, pool);
    } catch (err) {
      console.error('Fathom webhook error:', err);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Internal error' });
      }
    }
  });
}

// --- Proposal API (JSON body parsing) ---
app.use('/api/proposals', express.json(), createProposalRoutes(pool));

// --- Corrections API ---
app.use('/api/corrections', express.json(), createCorrectionRoutes(pool));

// --- Admin dashboard ---
app.use('/admin', createAdminRoutes(pool, config));

// --- Chat interface ---
app.use('/chat', createChatRoutes(pool, config));

// --- API key auth middleware for MCP routes ---
// Temporarily authless to support Claude Desktop (no custom header support).
// Network-level access via Cloudflare Tunnel provides perimeter security.
// Phase 9 will add per-user OAuth/JWT auth for MCP.
app.use('/mcp', (req, res, next) => {
  const key = req.headers['x-brain-key'] as string | undefined;
  if (key && !verifyAccessKey(key, config.brainAccessKey)) {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }
  next();
});

// --- MCP SSE transport ---
const mcpServer = createMcpServer(pool, config);

// Map to track active transports by session
const transports = new Map<string, SSEServerTransport>();

app.get('/mcp/sse', async (req, res) => {
  const transport = new SSEServerTransport('/mcp/messages', res);
  transports.set(transport.sessionId, transport);

  res.on('close', () => {
    transports.delete(transport.sessionId);
  });

  await mcpServer.connect(transport);
});

app.post('/mcp/messages', async (req, res) => {
  const sessionId = req.query.sessionId as string;
  const transport = transports.get(sessionId);

  if (!transport) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }

  await transport.handlePostMessage(req, res);
});

// --- Queue poller ---
let pollInterval: ReturnType<typeof setInterval>;

function startPoller() {
  pollInterval = setInterval(async () => {
    if (!acquireOllama('ingestion')) return;
    try {
      await pollQueue(pool, config);
    } catch (err) {
      console.error('Queue poll error:', err);
    } finally {
      releaseOllama('ingestion');
    }
  }, config.pollIntervalMs);
}

// --- Profile refresh poller ---
let profileInterval: ReturnType<typeof setInterval>;

function startProfileRefresher() {
  profileInterval = setInterval(async () => {
    if (!acquireOllama('background')) return;
    try {
      const count = await refreshStaleProfiles(pool, config);
      if (count > 0) {
        console.log(`Refreshed ${count} entity profile(s)`);
      }
    } catch (err) {
      console.error('Profile refresh error:', err);
    } finally {
      releaseOllama('background');
    }
  }, PROFILE_REFRESH_INTERVAL_MS);
}

// --- LinkedIn enrichment poller (optional — only if configured) ---
let linkedinInterval: ReturnType<typeof setInterval> | undefined;

function startLinkedInEnricher() {
  if (!config.serpApiKey) return;

  linkedinInterval = setInterval(async () => {
    try {
      const count = await enrichLinkedInBatch(pool, {
        serpApiKey: config.serpApiKey!,
      });
      if (count > 0) {
        console.log(`Created ${count} LinkedIn enrichment proposal(s)`);
      }
    } catch (err) {
      console.error('LinkedIn enrichment error:', err);
    }
  }, LINKEDIN_ENRICHMENT_INTERVAL_MS);
}

// --- Relationship description poller (optional — only if configured) ---
let relationshipInterval: ReturnType<typeof setInterval> | undefined;

function startRelationshipDescriber() {
  if (!config.relationshipModel) return;

  relationshipInterval = setInterval(async () => {
    if (!acquireOllama('background')) return;
    try {
      const count = await describeUndescribedRelationships(pool, {
        ollamaBaseUrl: config.ollamaBaseUrl,
        relationshipModel: config.relationshipModel!,
      });
      if (count > 0) {
        console.log(`Described ${count} relationship edge(s)`);
      }
    } catch (err) {
      console.error('Relationship description error:', err);
    } finally {
      releaseOllama('background');
    }
  }, RELATIONSHIP_DESCRIPTION_INTERVAL_MS);
}

// --- Community detection poller (pure graph algorithm, no Ollama needed) ---
let communityDetectionInterval: ReturnType<typeof setInterval> | undefined;

function startCommunityDetection() {
  communityDetectionInterval = setInterval(async () => {
    try {
      const result = await detectCommunities(pool);
      if (result.changed) {
        console.log(`Detected ${result.communities} communities (changed)`);
      }
    } catch (err) {
      console.error('Community detection error:', err);
    }
  }, COMMUNITY_DETECTION_INTERVAL_MS);
}

// --- Community summarizer poller (needs Ollama) ---
let communitySummaryInterval: ReturnType<typeof setInterval> | undefined;

function startCommunitySummarizer() {
  communitySummaryInterval = setInterval(async () => {
    if (!acquireOllama('background')) return;
    try {
      const count = await summarizeUnsummarizedCommunities(pool, config);
      if (count > 0) {
        console.log(`Summarized ${count} community/ies`);
      }
    } catch (err) {
      console.error('Community summary error:', err);
    } finally {
      releaseOllama('background');
    }
  }, COMMUNITY_SUMMARY_INTERVAL_MS);
}

// --- Model preloading ---
async function preloadModels() {
  const models = new Map<string, 'embed' | 'llm'>();
  models.set(config.embeddingModel, 'embed');
  models.set(config.extractionModel, 'llm');
  models.set(config.chatModel, 'llm');
  if (config.relationshipModel && !models.has(config.relationshipModel)) {
    models.set(config.relationshipModel, 'llm');
  }

  for (const [model, type] of models) {
    try {
      const start = Date.now();
      if (type === 'embed') {
        await fetch(`${config.ollamaBaseUrl}/api/embed`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model, input: 'warmup' }),
          signal: AbortSignal.timeout(300_000),
        });
      } else {
        await fetch(`${config.ollamaBaseUrl}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }], stream: false, options: { num_predict: 1 } }),
          signal: AbortSignal.timeout(300_000),
        });
      }
      console.log(`  Preloaded ${model} (${((Date.now() - start) / 1000).toFixed(1)}s)`);
    } catch (err) {
      console.warn(`  Failed to preload ${model}:`, (err as Error).message);
    }
  }
}

// --- Graceful shutdown ---
function shutdown() {
  console.log('Shutting down...');
  clearInterval(pollInterval);
  clearInterval(profileInterval);
  if (linkedinInterval) clearInterval(linkedinInterval);
  if (relationshipInterval) clearInterval(relationshipInterval);
  if (communityDetectionInterval) clearInterval(communityDetectionInterval);
  if (communitySummaryInterval) clearInterval(communitySummaryInterval);
  pool.end().then(() => {
    console.log('Database pool closed');
    process.exit(0);
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// --- Start ---
function startPollers() {
  startPoller();
  console.log(`  Queue poller: every ${config.pollIntervalMs}ms`);
  startProfileRefresher();
  console.log(`  Profile refresh: every ${PROFILE_REFRESH_INTERVAL_MS / 1000}s`);
  startLinkedInEnricher();
  if (config.serpApiKey) {
    console.log(`  LinkedIn enricher: every ${LINKEDIN_ENRICHMENT_INTERVAL_MS / 1000}s`);
  }
  startRelationshipDescriber();
  if (config.relationshipModel) {
    console.log(`  Relationship describer: every ${RELATIONSHIP_DESCRIPTION_INTERVAL_MS / 1000}s (model: ${config.relationshipModel})`);
  }
  startCommunityDetection();
  console.log(`  Community detection: every ${COMMUNITY_DETECTION_INTERVAL_MS / 1000}s`);
  startCommunitySummarizer();
  console.log(`  Community summarizer: every ${COMMUNITY_SUMMARY_INTERVAL_MS / 1000}s`);
  preloadModels().catch(err => console.error('Model preload error:', err));
}

function logStartup() {
  const uniqueModels = [...new Set([config.embeddingModel, config.extractionModel, config.chatModel, config.relationshipModel].filter(Boolean))];
  console.log(`  Models: ${uniqueModels.join(', ')}`);
  if (config.slackBotToken) console.log(`  Slack webhook: /slack/events`);
  if (config.telegramBotToken) console.log(`  Telegram webhook: /telegram/updates`);
  if (config.fathomApiKey) console.log(`  Fathom webhook: /fathom/events`);
  console.log(`  Admin dashboard: /admin`);
  console.log(`  Chat: /chat`);
}

// HTTP server
app.listen(config.mcpPort, () => {
  console.log(`DanielBrain HTTP on port ${config.mcpPort}`);
  console.log(`  MCP SSE: http://localhost:${config.mcpPort}/mcp/sse`);
  logStartup();
  startPollers();
});

// HTTPS server (for MCP clients that require TLS, e.g. Claude Desktop over Tailscale)
const certPath = path.resolve(process.cwd(), 'certs/cert.pem');
const keyPath = path.resolve(process.cwd(), 'certs/key.pem');
if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
  const httpsPort = config.mcpPort + 1;
  https.createServer(
    { cert: fs.readFileSync(certPath), key: fs.readFileSync(keyPath) },
    app,
  ).listen(httpsPort, () => {
    console.log(`DanielBrain HTTPS on port ${httpsPort}`);
    console.log(`  MCP SSE: https://100.120.74.69:${httpsPort}/mcp/sse`);
  });
}

export { app, pool };
