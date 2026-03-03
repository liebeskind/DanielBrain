import 'dotenv/config';
import express from 'express';
import pg from 'pg';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { loadConfig } from './config.js';
import { createMcpServer } from './mcp/server.js';
import { verifyAccessKey } from './auth.js';
import { verifySlackSignature } from './slack/verify.js';
import { handleSlackEvent } from './slack/webhook.js';
import { pollQueue } from './processor/queue-poller.js';

const config = loadConfig();
const pool = new pg.Pool({ connectionString: config.databaseUrl });

const app = express();

// --- Health check ---
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// --- Slack webhook (verified by HMAC, not by API key) ---
app.post('/slack/events', express.raw({ type: '*/*' }), async (req, res) => {
  const body = req.body.toString();

  const valid = verifySlackSignature({
    signature: req.headers['x-slack-signature'] as string,
    timestamp: req.headers['x-slack-request-timestamp'] as string,
    body,
    signingSecret: config.slackSigningSecret,
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

// --- Graceful shutdown ---
function shutdown() {
  console.log('Shutting down...');
  clearInterval(pollInterval);
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
  console.log(`  Slack webhook: http://localhost:${config.mcpPort}/slack/events`);
  console.log(`  Health: http://localhost:${config.mcpPort}/health`);
  startPoller();
  console.log(`  Queue poller: every ${config.pollIntervalMs}ms`);
});

export { app, pool };
