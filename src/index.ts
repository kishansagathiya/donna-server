import { serve } from '@hono/node-server';
import { createNodeWebSocket } from '@hono/node-ws';
import { Hono } from 'hono';
import os from 'node:os';
import { config } from './config.js';
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

const app = new Hono();
const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

app.get('/health', (c) =>
  c.json({ ok: true, service: 'donna-server' }),
);

app.get(
  '/voice',
  upgradeWebSocket(() => {
    let session: VoiceSession | null = null;

    return {
      onOpen(_event, ws) {
        session = new VoiceSession(ws);
        log('websocket connected');
      },
      async onMessage(event, ws) {
        if (!session) {
          session = new VoiceSession(ws);
        }
        await session.handleMessage(event.data);
      },
      onClose() {
        log('websocket disconnected', {
          sessionId: session?.sessionId,
        });
        session = null;
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
log(`voice (simulator): ws://127.0.0.1:${port}/voice`);
for (const ip of lanAddresses()) {
  log(`voice (physical device): ws://${ip}:${port}/voice`);
}
