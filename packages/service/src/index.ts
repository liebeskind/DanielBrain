import 'dotenv/config';
import fs from 'fs';
import https from 'https';
import path from 'path';
import express from 'express';
import pg from 'pg';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { loadConfig } from './config.js';
import { createMcpServer } from './mcp/server.js';
import { verifyAccessKey, optionalAuth } from './auth.js';
import { createUserRoutes } from './admin/user-routes.js';
import { BrainOAuthProvider } from './auth/oauth-provider.js';
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
import { createHubSpotClient } from './hubspot/client.js';
import { syncHubSpot } from './hubspot/sync.js';
import { verifyHubSpotSignature } from './hubspot/verify.js';
import { handleHubSpotEvents } from './hubspot/webhook.js';
import type { HubSpotObjectType } from './hubspot/types.js';
import { detectCommunities } from './processor/community-detector.js';
import { summarizeUnsummarizedCommunities } from './processor/community-summarizer.js';

const config = loadConfig();
const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: 20,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

const app = express();

// --- Ensure data directories exist ---
fs.mkdirSync(config.rawFilesDir, { recursive: true });
fs.mkdirSync(config.transcribeDir, { recursive: true });

// --- OAuth provider (optional — only when JWT_SECRET is configured) ---
let oauthProvider: BrainOAuthProvider | null = null;

async function setupOAuth() {
  if (!config.jwtSecret) return;

  const { mcpAuthRouter } = await import('@modelcontextprotocol/sdk/server/auth/router.js');

  oauthProvider = new BrainOAuthProvider(pool, config.jwtSecret);
  const issuerUrl = new URL(`http://localhost:${config.mcpPort}`);

  // Mount SDK OAuth router (handles /.well-known, /authorize, /token, /register, /revoke)
  app.use(mcpAuthRouter({
    provider: oauthProvider,
    issuerUrl,
    scopesSupported: ['read', 'write'],
  }));

  // Custom callback route for the API-key login form
  app.post('/authorize/callback', express.urlencoded({ extended: false }), async (req, res) => {
    try {
      await oauthProvider!.handleAuthorizeCallback(
        req.body.api_key,
        req.body.client_id,
        req.body.redirect_uri,
        req.body.code_challenge,
        req.body.state || undefined,
        res,
      );
    } catch (err) {
      console.error('OAuth callback error:', err);
      res.status(500).json({ error: 'Authorization failed' });
    }
  });

  // Cleanup expired codes/tokens every 10 minutes
  setInterval(() => oauthProvider!.cleanup(), 600_000);
}

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

// --- HubSpot webhook (optional — only if configured) ---
if (config.hubspotAccessToken && config.hubspotWebhookSecret) {
  const hubspotWebhookClient = createHubSpotClient(config.hubspotAccessToken);
  app.post('/hubspot/events', express.raw({ type: '*/*' }), async (req, res) => {
    const body = req.body.toString();

    const valid = verifyHubSpotSignature({
      signature: req.headers['x-hubspot-signature-v3'] as string | undefined,
      timestamp: req.headers['x-hubspot-request-timestamp'] as string | undefined,
      requestMethod: 'POST',
      requestUri: `${req.protocol}://${req.get('host')}${req.originalUrl}`,
      body,
      secret: config.hubspotWebhookSecret!,
    });

    if (!valid) {
      res.status(401).json({ error: 'Invalid signature' });
      return;
    }

    try {
      const events = JSON.parse(body);
      res.status(200).json({ ok: true });

      const result = await handleHubSpotEvents(events, pool, hubspotWebhookClient);
      if (result.processed > 0) {
        console.log(`HubSpot webhook: ${result.processed} processed, ${result.skipped} skipped, ${result.errors} errors`);
      }
    } catch (err) {
      console.error('HubSpot webhook error:', err);
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

// --- User management API (admin) ---
app.use('/admin/api/users', express.json(), createUserRoutes(pool));

// --- Chat interface (optional auth for user scoping) ---
app.use('/chat', optionalAuth(pool, config.brainAccessKey), createChatRoutes(pool, config));

// --- Auth middleware for MCP routes ---
// Bearer auth (JWT from OAuth) checked first if available, then API key / CF JWT fallback.
app.use('/mcp', async (req, res, next) => {
  if (oauthProvider && req.headers.authorization?.startsWith('Bearer ')) {
    try {
      const authInfo = await oauthProvider.verifyAccessToken(
        req.headers.authorization.slice(7),
      );
      (req as any).auth = authInfo;
      req.userContext = {
        userId: authInfo.extra?.userId as string,
        email: authInfo.extra?.email as string,
        displayName: authInfo.extra?.displayName as string,
        role: authInfo.extra?.role as any,
        visibilityTags: (authInfo.extra?.visibilityTags as string[]) || [],
      };
      next();
      return;
    } catch {
      res.status(401).json({ error: 'Invalid or expired token' });
      return;
    }
  }
  next();
});
app.use('/mcp', optionalAuth(pool, config.brainAccessKey));

// --- MCP SSE transport ---
// Each SSE connection gets its own McpServer instance (SDK requires 1:1 server↔transport).
const transports = new Map<string, SSEServerTransport>();

app.get('/mcp/sse', async (req, res) => {
  const transport = new SSEServerTransport('/mcp/messages', res);
  const mcpServer = createMcpServer(pool, config);
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

// --- HubSpot sync poller (optional — only if configured) ---
let hubspotInterval: ReturnType<typeof setInterval> | undefined;

function startHubSpotSync() {
  if (!config.hubspotAccessToken) return;

  const hsClient = createHubSpotClient(config.hubspotAccessToken);
  const objectTypes = config.hubspotObjectTypes.split(',').map(s => s.trim()) as HubSpotObjectType[];

  // Run initial sync immediately, then on interval
  syncHubSpot(hsClient, pool, objectTypes)
    .then(result => {
      const total = result.contacts + result.companies + result.deals;
      if (total > 0) {
        console.log(`HubSpot initial sync: ${result.contacts} contacts, ${result.companies} companies, ${result.deals} deals queued`);
      }
    })
    .catch(err => console.error('HubSpot initial sync error:', err));

  hubspotInterval = setInterval(async () => {
    try {
      const result = await syncHubSpot(hsClient, pool, objectTypes);
      const total = result.contacts + result.companies + result.deals;
      if (total > 0) {
        console.log(`HubSpot sync: ${result.contacts} contacts, ${result.companies} companies, ${result.deals} deals queued`);
      }
    } catch (err) {
      console.error('HubSpot sync error:', err);
    }
  }, config.hubspotPollIntervalMs);
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
let isShuttingDown = false;

function shutdown() {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log('Shutting down...');

  // Stop all pollers
  clearInterval(pollInterval);
  clearInterval(profileInterval);
  if (linkedinInterval) clearInterval(linkedinInterval);
  if (relationshipInterval) clearInterval(relationshipInterval);
  if (communityDetectionInterval) clearInterval(communityDetectionInterval);
  if (communitySummaryInterval) clearInterval(communitySummaryInterval);
  if (hubspotInterval) clearInterval(hubspotInterval);

  // Wait for in-flight operations to settle, then close pool
  // Short delay lets active poller iterations complete
  setTimeout(async () => {
    try {
      await pool.end();
      console.log('Database pool closed');
    } catch (err) {
      console.error('Error closing pool:', err);
    }
    process.exit(0);
  }, 2000);
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
  startHubSpotSync();
  if (config.hubspotAccessToken) {
    console.log(`  HubSpot sync: every ${config.hubspotPollIntervalMs / 1000}s (${config.hubspotObjectTypes})`);
  }
  preloadModels().catch(err => console.error('Model preload error:', err));
}

function logStartup() {
  const uniqueModels = [...new Set([config.embeddingModel, config.extractionModel, config.chatModel, config.relationshipModel].filter(Boolean))];
  console.log(`  Models: ${uniqueModels.join(', ')}`);
  if (config.slackBotToken) console.log(`  Slack webhook: /slack/events`);
  if (config.telegramBotToken) console.log(`  Telegram webhook: /telegram/updates`);
  if (config.fathomApiKey) console.log(`  Fathom webhook: /fathom/events`);
  if (config.hubspotAccessToken) console.log(`  HubSpot sync: polling`);
  if (config.hubspotWebhookSecret) console.log(`  HubSpot webhook: /hubspot/events`);
  console.log(`  Admin dashboard: /admin`);
  console.log(`  Chat: /chat`);
}

// HTTP server — setup OAuth before listening
setupOAuth()
  .then(() => {
    app.listen(config.mcpPort, () => {
      console.log(`DanielBrain HTTP on port ${config.mcpPort}`);
      console.log(`  MCP SSE: http://localhost:${config.mcpPort}/mcp/sse`);
      if (oauthProvider) console.log('  OAuth: enabled');
      logStartup();
      startPollers();
    });
  })
  .catch((err) => {
    console.error('OAuth setup failed:', err);
    process.exit(1);
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
