import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RpcBridge } from './rpc-bridge.js';
import { createRouter } from './routes.js';
import { createSessionStore } from './sessions.js';
import { SseHub } from './sse.js';

const PORT = Number(process.env.PORT ?? 3001);
const HOST = '127.0.0.1';
const PI_BINARY = process.env.PI_BINARY ?? 'pi';
const AGENT_CWD = process.env.PI_CWD ?? process.cwd();

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));

const bridge = new RpcBridge(PI_BINARY, AGENT_CWD);
const sessions = createSessionStore();
const hub = new SseHub();

bridge.on('event', (event) => {
  hub.broadcast(event);
});
bridge.on('error', (error) => {
  console.error(`[rpc] ${error.message}`);
});
bridge.start();

app.use(createRouter(bridge, sessions, hub));

// Production: serve the built SPA with an index.html fallback for client routes.
const serverDir = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(serverDir, '..', '..', 'dist');
app.use(express.static(distDir));
app.use((req, res, next) => {
  if (req.method !== 'GET' || req.path.startsWith('/api/')) {
    next();
    return;
  }
  res.sendFile(path.join(distDir, 'index.html'));
});

// Express 5 forwards rejected async handlers here.
app.use(
  (
    err: unknown,
    _req: express.Request,
    res: express.Response,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _next: express.NextFunction,
  ) => {
    console.error(`[http] ${err instanceof Error ? err.message : String(err)}`);
    if (!res.headersSent) {
      res.status(500).json({ error: 'internal server error' });
    }
  },
);

const shutdown = (): void => {
  console.log('shutting down…');
  bridge.stop();
  hub.close();
  setTimeout(() => {
    process.exit(0);
  }, 300);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

app.listen(PORT, HOST, () => {
  console.log(`pi-panel server listening on http://${HOST}:${String(PORT)}`);
  console.log(`pi binary: ${PI_BINARY}`);
});
