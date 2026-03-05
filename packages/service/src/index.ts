import 'dotenv/config';
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
import { PROFILE_REFRESH_INTERVAL_MS, LINKEDIN_ENRICHMENT_INTERVAL_MS } from '@danielbrain/shared';
import { createProposalRoutes } from './proposals/routes.js';
import { createAdminRoutes } from './admin/routes.js';
import { enrichLinkedInBatch } from './enrichers/linkedin.js';
import { verifyFathomSignature } from './fathom/verify.js';
import { handleFathomEvent } from './fathom/webhook.js';

const config = loadConfig();
const pool = new pg.Pool({ connectionString: config.databaseUrl });

const app = express();

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

// --- Admin dashboard ---
app.use('/admin', createAdminRoutes(pool));

// --- API key auth middleware for MCP routes ---
app.use('/mcp', (req, res, next) => {
  const key = req.headers['x-brain-key'] as string | undefined;
  if (!verifyAccessKey(key, config.brainAccessKey)) {
    res.status(key ? 403 : 401).json({ error: key ? 'Forbidden' : 'Unauthorized' });
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
    try {
      await pollQueue(pool, config);
    } catch (err) {
      console.error('Queue poll error:', err);
    }
  }, config.pollIntervalMs);
}

// --- Profile refresh poller ---
let profileInterval: ReturnType<typeof setInterval>;

function startProfileRefresher() {
  profileInterval = setInterval(async () => {
    try {
      const count = await refreshStaleProfiles(pool, config);
      if (count > 0) {
        console.log(`Refreshed ${count} entity profile(s)`);
      }
    } catch (err) {
      console.error('Profile refresh error:', err);
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

// --- Graceful shutdown ---
function shutdown() {
  console.log('Shutting down...');
  clearInterval(pollInterval);
  clearInterval(profileInterval);
  if (linkedinInterval) clearInterval(linkedinInterval);
  pool.end().then(() => {
    console.log('Database pool closed');
    process.exit(0);
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// --- Start ---
app.listen(config.mcpPort, () => {
  console.log(`DanielBrain running on port ${config.mcpPort}`);
  console.log(`  MCP SSE: http://localhost:${config.mcpPort}/mcp/sse`);
  if (config.slackBotToken) {
    console.log(`  Slack webhook: http://localhost:${config.mcpPort}/slack/events`);
  }
  if (config.telegramBotToken) {
    console.log(`  Telegram webhook: http://localhost:${config.mcpPort}/telegram/updates`);
  }
  if (config.fathomApiKey) {
    console.log(`  Fathom webhook: http://localhost:${config.mcpPort}/fathom/events`);
  }
  console.log(`  Health: http://localhost:${config.mcpPort}/health`);
  console.log(`  Admin dashboard: http://localhost:${config.mcpPort}/admin`);
  console.log(`  Proposals API: http://localhost:${config.mcpPort}/api/proposals`);
  startPoller();
  console.log(`  Queue poller: every ${config.pollIntervalMs}ms`);
  startProfileRefresher();
  console.log(`  Profile refresh: every ${PROFILE_REFRESH_INTERVAL_MS / 1000}s`);
  startLinkedInEnricher();
  if (config.serpApiKey) {
    console.log(`  LinkedIn enricher: every ${LINKEDIN_ENRICHMENT_INTERVAL_MS / 1000}s`);
  }
});

export { app, pool };
