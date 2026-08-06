import express from 'express';
import path from 'node:path';
import { RpcBridge } from './rpc-bridge.js';
import { createRouter } from './routes.js';
import { createFileSessionProvider } from './providers/file-session-provider.js';
import { createMockSessionProvider } from './providers/mock-session-provider.js';
import { DemoStateMachine } from './demo/state-machine.js';
import { SseHub } from './sse.js';

const PORT = Number(process.env.PORT ?? 3001);
const HOST = '127.0.0.1';
const PI_BINARY = process.env.PI_BINARY ?? 'pi';
const AGENT_CWD = process.env.PI_CWD ?? process.cwd();

// kMode (KMODE-001 K2): runtime mode decided once at startup.
type PanelMode = 'production' | 'debug' | 'demo';
const rawMode = process.env.PIHUB_MODE ?? 'production';
const mode: PanelMode = rawMode === 'debug' || rawMode === 'demo' ? rawMode : 'production';

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));

// Data isolation: demo mode never touches ~/.pi and never spawns real pi.
const sessions =
  mode === 'demo' ? createMockSessionProvider() : createFileSessionProvider();
const hub = new SseHub();
const bridge = new RpcBridge(PI_BINARY, AGENT_CWD);

bridge.on('event', (event) => {
  hub.broadcast(event);
});
bridge.on('ui-request', (request) => {
  hub.broadcast(request);
});
bridge.on('error', (error) => {
  console.error(`[rpc] ${error.message}`);
});
if (mode === 'debug') {
  // kMode K6: frame-level diagnostics in debug mode.
  bridge.on('response', (response) => {
    console.log(`[kMode:debug] rpc response id=${response.id ?? '-'} success=${String(response.success)}`);
  });
  bridge.on('event', (event) => {
    console.log(`[kMode:debug] event type=${event.type}`);
  });
}
if (mode !== 'demo') {
  bridge.start();
}

const demoMachine = mode === 'demo' ? new DemoStateMachine(hub, sessions) : null;

app.use(
  createRouter(bridge, sessions, hub, {
    mode,
    demoMachine,
    ...(mode === 'debug'
      ? {
          debugState: (): Record<string, unknown> => ({
            bridgeRunning: bridge.isRunning(),
            pendingRpcRequests: bridge.pendingRequestCount(),
            pendingUiRequests: bridge.getPendingUiRequests().map((r) => r.id),
            sseClients: hub.clientCount(),
          }),
        }
      : {}),
  }),
);

// Production: serve the built SPA with an index.html fallback for client routes.
// When dist is absent (dev mode), return a JSON hint instead of a 500.
const distDir = path.resolve(process.cwd(), 'dist');
const indexFile = path.join(distDir, 'index.html');
app.use(express.static(distDir));
app.use((req, res, next) => {
  if (req.method !== 'GET' || req.path.startsWith('/api/')) {
    next();
    return;
  }
  res.sendFile(indexFile, (err) => {
    if (err !== undefined) {
      res.status(404).json({
        error: 'frontend build not found — run `npm run build` or use the Vite dev server on port 18384',
      });
    }
  });
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
