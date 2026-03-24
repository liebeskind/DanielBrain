import 'dotenv/config';
import { randomUUID } from 'crypto';
import fs from 'fs';
import https from 'https';
import path from 'path';
import express from 'express';
import pg from 'pg';
import pinoHttp from 'pino-http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
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
import { enrichUrlBatch } from './enrichers/url-enricher.js';
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
import { logger, createChildLogger } from './logger.js';
import { sanitizeError } from './errors.js';
import { recordPollerSuccess, recordPollerError, getPollerStatuses } from './poller-status.js';
import { authLimiter, uploadLimiter, mcpLimiter, chatLimiter, adminApiLimiter } from './rate-limit.js';
import { logAudit } from './audit.js';

const config = loadConfig();
const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: 20,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

const app = express();

// Trust first proxy (Cloudflare) for correct IP in rate limiters
app.set('trust proxy', 1);

// --- pino-http middleware (skip /health to reduce noise) ---
app.use(pinoHttp({
  logger,
  genReqId: (req) => (req.headers['x-request-id'] as string) || randomUUID(),
  autoLogging: { ignore: (req) => req.url === '/health' },
}));

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

  // Rate limit auth routes
  app.use('/authorize', authLimiter);

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
      logger.error({ err }, 'OAuth callback error');
      res.status(500).json({ error: 'Authorization failed' });
    }
  });

  // Cleanup expired codes/tokens every 10 minutes
  setInterval(() => oauthProvider!.cleanup(), 600_000);
}

// --- Health check (enhanced readiness probe) ---
app.get('/health', async (_req, res) => {
  const checks: Record<string, unknown> = {};
  let status: 'ok' | 'degraded' | 'unhealthy' = 'ok';

  // Database connectivity
  try {
    await pool.query('SELECT 1');
    checks.database = 'ok';
  } catch {
    checks.database = 'unavailable';
    status = 'unhealthy';
  }

  // Ollama connectivity
  try {
    const resp = await fetch(`${config.ollamaBaseUrl}/api/tags`, {
      signal: AbortSignal.timeout(3000),
    });
    checks.ollama = resp.ok ? 'ok' : 'unavailable';
    if (!resp.ok && status === 'ok') status = 'degraded';
  } catch {
    checks.ollama = 'unavailable';
    if (status === 'ok') status = 'degraded';
  }

  // Poller health
  checks.pollers = getPollerStatuses();

  // Active MCP sessions
  checks.mcpSessions = sessions.size;

  res.status(status === 'unhealthy' ? 503 : 200).json({
    status,
    timestamp: new Date().toISOString(),
    checks,
  });
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
      logger.error({ err }, 'Slack webhook error');
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
      logger.error({ err }, 'Telegram webhook error');
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
      logger.error({ err }, 'Fathom webhook error');
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

      const result = await handleHubSpotEvents(events, pool, hubspotWebhookClient, {
        requireContactActivity: config.hubspotRequireContactActivity,
      });
      if (result.processed > 0) {
        logger.info({ processed: result.processed, skipped: result.skipped, errors: result.errors }, 'HubSpot webhook processed');
      }
    } catch (err) {
      logger.error({ err }, 'HubSpot webhook error');
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
app.use('/admin/api', adminApiLimiter);
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
      logAudit(pool, {
        userId: null,
        action: 'auth_failed',
        metadata: { reason: 'invalid_bearer_token', ip: getClientIp(req) },
      });
      res.status(401).json({ error: 'Invalid or expired token' });
      return;
    }
  }
  next();
});
app.use('/mcp', optionalAuth(pool, config.brainAccessKey));

// --- MCP Streamable HTTP transport ---
// Each session gets its own McpServer instance + transport (SDK requires 1:1 server↔transport).
const sessions = new Map<string, StreamableHTTPServerTransport>();

// Rate limit MCP protocol messages
app.use('/mcp', mcpLimiter);

app.all('/mcp', async (req, res) => {
  // For GET requests (standalone SSE stream) and DELETE (session teardown),
  // look up existing session
  const sessionId = req.headers['mcp-session-id'] as string | undefined;

  if (req.method === 'GET' || req.method === 'DELETE') {
    if (!sessionId || !sessions.has(sessionId)) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    const transport = sessions.get(sessionId)!;
    await transport.handleRequest(req, res);
    return;
  }

  // POST — could be initialization or an existing session message
  if (sessionId && sessions.has(sessionId)) {
    const transport = sessions.get(sessionId)!;
    await transport.handleRequest(req, res, req.body);
    return;
  }

  // New session — create transport + MCP server
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
  });

  transport.onclose = () => {
    const sid = transport.sessionId;
    if (sid) {
      sessions.delete(sid);
      logger.info({ sessionId: sid }, 'MCP session closed');
    }
  };

  const mcpServer = createMcpServer(pool, config);
  await mcpServer.connect(transport);

  await transport.handleRequest(req, res, req.body);

  // After handling the init request, the transport has a sessionId
  if (transport.sessionId) {
    sessions.set(transport.sessionId, transport);
    logger.info({ sessionId: transport.sessionId }, 'MCP session created');
  }
});

// --- Backward compat: redirect old SSE endpoint ---
app.get('/mcp/sse', (_req, res) => {
  res.status(410).json({
    error: 'SSE transport has been replaced by Streamable HTTP. Connect to POST /mcp instead.',
  });
});
app.post('/mcp/messages', (_req, res) => {
  res.status(410).json({
    error: 'SSE transport has been replaced by Streamable HTTP. Connect to POST /mcp instead.',
  });
});

// --- Express catch-all error handler ---
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  logger.error({ err }, 'Unhandled Express error');
  res.status(500).json({ error: sanitizeError(err) });
});

// --- Queue poller ---
const queueLog = createChildLogger('queue-poller');
let pollInterval: ReturnType<typeof setInterval>;

function startPoller() {
  pollInterval = setInterval(async () => {
    if (!acquireOllama('ingestion')) return;
    try {
      await pollQueue(pool, config);
      recordPollerSuccess('queue-poller');
    } catch (err) {
      queueLog.error({ err }, 'Queue poll error');
      recordPollerError('queue-poller', (err as Error).message);
    } finally {
      releaseOllama('ingestion');
    }
  }, config.pollIntervalMs);
}

// --- Profile refresh poller ---
const profileLog = createChildLogger('profile-refresher');
let profileInterval: ReturnType<typeof setInterval>;

function startProfileRefresher() {
  profileInterval = setInterval(async () => {
    if (!acquireOllama('background')) return;
    try {
      const count = await refreshStaleProfiles(pool, config);
      if (count > 0) {
        profileLog.info({ count }, 'Refreshed entity profiles');
      }
      recordPollerSuccess('profile-refresher');
    } catch (err) {
      profileLog.error({ err }, 'Profile refresh error');
      recordPollerError('profile-refresher', (err as Error).message);
    } finally {
      releaseOllama('background');
    }
  }, PROFILE_REFRESH_INTERVAL_MS);
}

// --- LinkedIn enrichment poller (optional — only if configured) ---
const linkedinLog = createChildLogger('linkedin-enricher');
let linkedinInterval: ReturnType<typeof setInterval> | undefined;

function startLinkedInEnricher() {
  if (!config.serpApiKey) return;

  linkedinInterval = setInterval(async () => {
    try {
      const count = await enrichLinkedInBatch(pool, {
        serpApiKey: config.serpApiKey!,
      });
      if (count > 0) {
        linkedinLog.info({ count }, 'Created LinkedIn enrichment proposals');
      }
      recordPollerSuccess('linkedin-enricher');
    } catch (err) {
      linkedinLog.error({ err }, 'LinkedIn enrichment error');
      recordPollerError('linkedin-enricher', (err as Error).message);
    }
  }, LINKEDIN_ENRICHMENT_INTERVAL_MS);
}

// --- URL enrichment poller (optional — only when HubSpot is configured) ---
import { URL_ENRICHMENT_INTERVAL_MS } from '@danielbrain/shared';
const urlEnrichLog = createChildLogger('url-enricher');
let urlEnrichInterval: ReturnType<typeof setInterval> | undefined;

function startUrlEnricher() {
  if (!config.hubspotAccessToken) return;

  urlEnrichInterval = setInterval(async () => {
    try {
      const count = await enrichUrlBatch(pool);
      if (count > 0) {
        urlEnrichLog.info({ count }, 'Processed URLs from HubSpot notes');
      }
      recordPollerSuccess('url-enricher');
    } catch (err) {
      urlEnrichLog.error({ err }, 'URL enrichment error');
      recordPollerError('url-enricher', (err as Error).message);
    }
  }, URL_ENRICHMENT_INTERVAL_MS);
}

// --- Relationship description poller (optional — only if configured) ---
const relationshipLog = createChildLogger('relationship-describer');
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
        relationshipLog.info({ count }, 'Described relationship edges');
      }
      recordPollerSuccess('relationship-describer');
    } catch (err) {
      relationshipLog.error({ err }, 'Relationship description error');
      recordPollerError('relationship-describer', (err as Error).message);
    } finally {
      releaseOllama('background');
    }
  }, RELATIONSHIP_DESCRIPTION_INTERVAL_MS);
}

// --- Community detection poller (pure graph algorithm, no Ollama needed) ---
const communityDetectLog = createChildLogger('community-detector');
let communityDetectionInterval: ReturnType<typeof setInterval> | undefined;

function startCommunityDetection() {
  communityDetectionInterval = setInterval(async () => {
    try {
      const result = await detectCommunities(pool);
      if (result.changed) {
        communityDetectLog.info({ communities: result.communities }, 'Detected communities (changed)');
      }
      recordPollerSuccess('community-detector');
    } catch (err) {
      communityDetectLog.error({ err }, 'Community detection error');
      recordPollerError('community-detector', (err as Error).message);
    }
  }, COMMUNITY_DETECTION_INTERVAL_MS);
}

// --- Community summarizer poller (needs Ollama) ---
const communitySumLog = createChildLogger('community-summarizer');
let communitySummaryInterval: ReturnType<typeof setInterval> | undefined;

function startCommunitySummarizer() {
  communitySummaryInterval = setInterval(async () => {
    if (!acquireOllama('background')) return;
    try {
      const count = await summarizeUnsummarizedCommunities(pool, config);
      if (count > 0) {
        communitySumLog.info({ count }, 'Summarized communities');
      }
      recordPollerSuccess('community-summarizer');
    } catch (err) {
      communitySumLog.error({ err }, 'Community summary error');
      recordPollerError('community-summarizer', (err as Error).message);
    } finally {
      releaseOllama('background');
    }
  }, COMMUNITY_SUMMARY_INTERVAL_MS);
}

// --- HubSpot sync poller (optional — only if configured) ---
const hubspotLog = createChildLogger('hubspot-sync');
let hubspotInterval: ReturnType<typeof setInterval> | undefined;

function startHubSpotSync() {
  if (!config.hubspotAccessToken) return;

  const hsClient = createHubSpotClient(config.hubspotAccessToken);
  const objectTypes = config.hubspotObjectTypes.split(',').map(s => s.trim()) as HubSpotObjectType[];
  const hubspotSyncOptions = { requireContactActivity: config.hubspotRequireContactActivity };

  // Run initial sync immediately, then start interval AFTER it completes
  let hubspotSyncing = false;

  async function runSync(label: string) {
    if (hubspotSyncing) {
      hubspotLog.debug('HubSpot sync already in progress, skipping');
      return;
    }
    hubspotSyncing = true;
    try {
      const result = await syncHubSpot(hsClient, pool, objectTypes, hubspotSyncOptions);
      const total = result.contacts + result.companies + result.deals + result.notes + result.calls + result.emails + result.meetings + result.tasks;
      if (total > 0 || result.fathomLinked > 0) {
        hubspotLog.info({ ...result }, `HubSpot ${label}`);
      }
      recordPollerSuccess('hubspot-sync');
    } catch (err) {
      hubspotLog.error({ err }, `HubSpot ${label} error`);
      recordPollerError('hubspot-sync', (err as Error).message);
    } finally {
      hubspotSyncing = false;
    }
  }

  runSync('initial sync');

  hubspotInterval = setInterval(() => runSync('sync'), config.hubspotPollIntervalMs);
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
      logger.info({ model, durationSec: ((Date.now() - start) / 1000).toFixed(1) }, 'Preloaded model');
    } catch (err) {
      logger.warn({ model, err }, 'Failed to preload model');
    }
  }
}

// --- Helper: extract client IP from request ---
function getClientIp(req: express.Request): string | null {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string') return xff.split(',')[0].trim();
  return req.socket?.remoteAddress ?? null;
}

// --- Graceful shutdown ---
let isShuttingDown = false;

function shutdown() {
  if (isShuttingDown) return;
  isShuttingDown = true;
  logger.info('Shutting down...');

  // Stop all pollers
  clearInterval(pollInterval);
  clearInterval(profileInterval);
  if (linkedinInterval) clearInterval(linkedinInterval);
  if (urlEnrichInterval) clearInterval(urlEnrichInterval);
  if (relationshipInterval) clearInterval(relationshipInterval);
  if (communityDetectionInterval) clearInterval(communityDetectionInterval);
  if (communitySummaryInterval) clearInterval(communitySummaryInterval);
  if (hubspotInterval) clearInterval(hubspotInterval);

  // Close all MCP sessions
  for (const [sid, transport] of sessions) {
    transport.close().catch(() => {});
    sessions.delete(sid);
  }

  // Wait for in-flight operations to settle, then close pool
  setTimeout(async () => {
    try {
      await pool.end();
      logger.info('Database pool closed');
    } catch (err) {
      logger.error({ err }, 'Error closing pool');
    }
    process.exit(0);
  }, 2000);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// --- Start ---
function startPollers() {
  startPoller();
  logger.info({ intervalMs: config.pollIntervalMs }, 'Queue poller started');
  startProfileRefresher();
  logger.info({ intervalMs: PROFILE_REFRESH_INTERVAL_MS }, 'Profile refresher started');
  startLinkedInEnricher();
  if (config.serpApiKey) {
    logger.info({ intervalMs: LINKEDIN_ENRICHMENT_INTERVAL_MS }, 'LinkedIn enricher started');
  }
  startUrlEnricher();
  if (config.hubspotAccessToken) {
    logger.info({ intervalMs: URL_ENRICHMENT_INTERVAL_MS }, 'URL enricher started');
  }
  startRelationshipDescriber();
  if (config.relationshipModel) {
    logger.info({ intervalMs: RELATIONSHIP_DESCRIPTION_INTERVAL_MS, model: config.relationshipModel }, 'Relationship describer started');
  }
  startCommunityDetection();
  logger.info({ intervalMs: COMMUNITY_DETECTION_INTERVAL_MS }, 'Community detection started');
  startCommunitySummarizer();
  logger.info({ intervalMs: COMMUNITY_SUMMARY_INTERVAL_MS }, 'Community summarizer started');
  startHubSpotSync();
  if (config.hubspotAccessToken) {
    logger.info({ intervalMs: config.hubspotPollIntervalMs, objectTypes: config.hubspotObjectTypes }, 'HubSpot sync started');
  }
  preloadModels().catch(err => logger.error({ err }, 'Model preload error'));
}

function logStartup() {
  const uniqueModels = [...new Set([config.embeddingModel, config.extractionModel, config.chatModel, config.relationshipModel].filter(Boolean))];
  logger.info({ models: uniqueModels }, 'Models configured');
  if (config.slackBotToken) logger.info('Slack webhook: /slack/events');
  if (config.telegramBotToken) logger.info('Telegram webhook: /telegram/updates');
  if (config.fathomApiKey) logger.info('Fathom webhook: /fathom/events');
  if (config.hubspotAccessToken) logger.info('HubSpot sync: polling');
  if (config.hubspotWebhookSecret) logger.info('HubSpot webhook: /hubspot/events');
  logger.info('Admin dashboard: /admin');
  logger.info('Chat: /chat');
}

// HTTP server — setup OAuth before listening
setupOAuth()
  .then(() => {
    app.listen(config.mcpPort, () => {
      logger.info({ port: config.mcpPort }, 'DanielBrain HTTP server started');
      logger.info({ endpoint: `http://localhost:${config.mcpPort}/mcp` }, 'MCP Streamable HTTP');
      if (oauthProvider) logger.info('OAuth: enabled');
      logStartup();
      startPollers();
    });
  })
  .catch((err) => {
    logger.error({ err }, 'OAuth setup failed');
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
    logger.info({ port: httpsPort }, 'DanielBrain HTTPS server started');
    logger.info({ endpoint: `https://100.120.74.69:${httpsPort}/mcp` }, 'MCP Streamable HTTP (HTTPS)');
  });
}

export { app, pool };
