import { serve } from '@hono/node-server';
import { createNodeWebSocket } from '@hono/node-ws';
import { Hono } from 'hono';
import type { WSContext } from 'hono/ws';
import os from 'node:os';
import { verifyAccessToken } from './auth.js';
import { config } from './config.js';
import {
  handleKnowledgeFormats,
  handleKnowledgeIngest,
} from './knowledge/ingest/handler.js';
import { requireAuth, type AuthVariables } from './middleware/auth.js';
import { log } from './log.js';
import { VoiceSession } from './session.js';

function lanAddresses(): string[] {
  const addrs: string[] = [];
  for (const nets of Object.values(os.networkInterfaces())) {
    for (const net of nets ?? []) {
      if (net.family === 'IPv4' && !net.internal) {
        addrs.push(net.address);
      }
    }
  }
  return addrs;
}

async function verifyVoiceToken(token: string | undefined): Promise<string | null> {
  if (!config.requireAuth) {
    return null;
  }

  if (!token) {
    throw new Error('missing_token');
  }

  const verified = await verifyAccessToken(token, {
    supabaseUrl: config.supabaseUrl,
    jwtAudience: config.jwtAudience,
  });
  return verified.userId;
}

const app = new Hono<{ Variables: AuthVariables }>();
const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

app.get('/health', (c) =>
  c.json({
    ok: true,
    service: 'donna-server',
    authRequired: config.requireAuth,
  }),
);

app.get('/knowledge/formats', handleKnowledgeFormats);
app.post('/knowledge/ingest', requireAuth, handleKnowledgeIngest);

app.get(
  '/voice',
  upgradeWebSocket((c) => {
    let session: VoiceSession | null = null;
    let userId: string | null = null;
    let rejected = false;
    let initPromise: Promise<void> | null = null;

    const initSession = (ws: WSContext): Promise<void> => {
      if (!initPromise) {
        initPromise = (async () => {
          try {
            userId = await verifyVoiceToken(c.req.query('token'));
            session = new VoiceSession(ws, { userId: userId ?? undefined });
            log('websocket connected', { userId });
          } catch (error) {
            rejected = true;
            const code =
              error instanceof Error ? error.message : 'invalid_token';
            log('websocket auth rejected', { code });
            ws.close(4401, code);
          }
        })();
      }
      return initPromise;
    };

    return {
      onOpen(_event, ws) {
        void initSession(ws);
      },
      async onMessage(event, ws) {
        if (rejected) return;

        await initSession(ws);
        if (!session) return;

        await session.handleMessage(event.data);
      },
      onClose() {
        session?.end();
        log('websocket disconnected', {
          sessionId: session?.sessionId,
          userId,
        });
        session = null;
        initPromise = null;
      },
    };
  }),
);

const server = serve({
  fetch: app.fetch,
  hostname: config.host,
  port: config.port,
});
injectWebSocket(server);

const port = config.port;
log(`listening on http://${config.host}:${port}`);
log(`health: http://127.0.0.1:${port}/health`);
log(`voice auth: ${config.requireAuth ? 'required (Supabase JWT)' : 'disabled'}`);
log(
  `conversation persistence: ${config.persistConversations ? 'enabled' : 'disabled'}`,
);
log(`knowledge base: ${config.persistKnowledge ? 'enabled' : 'disabled'}`);
log('knowledge ingest: POST /knowledge/ingest, GET /knowledge/formats');
log(`voice (simulator): ws://127.0.0.1:${port}/voice`);
for (const ip of lanAddresses()) {
  log(`voice (physical device): ws://${ip}:${port}/voice`);
}
