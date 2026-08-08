import express from 'express';
import path from 'node:path';
import { RpcBridge } from './rpc-bridge.js';
import { createRouter } from './routes.js';
import { createFileSessionProvider } from './providers/file-session-provider.js';
import { createMockSessionProvider } from './providers/mock-session-provider.js';
import { DemoStateMachine } from './demo/state-machine.js';
import { SseHub } from './sse.js';
import { PipelineEngine } from './pipelines/engine.js';
import { createPipelineStore } from './pipelines/store.js';
import { seedDemoPipelines } from './demo/demo-pipelines.js';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import { createSecurityGate, requiresToken } from './security.js';
import { PiAdapter } from './adapters/pi-adapter.js';
import { listCodexSessions, parseRolloutFile, type CodexSessionDetail } from './adapters/codex-history.js';

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

// SPRINT-2 A1: local control-plane security gate. Host + Origin checks run
// for every request; the per-process control token is mandatory in
// production (injected into the served index.html, read back by the SPA for
// fetch headers and SSE query params). Demo/debug keep Host/Origin gating
// but may disable the token via env — demo already has 503 write guards and
// synthetic data, and the dev tooling (vite origin + curl probes) must keep
// working.
const security = createSecurityGate();
const tokenEnabled = mode === 'production' || process.env.PIHUB_DEV_NO_TOKEN !== '1';
app.use(security.middleware.bind(security));
app.use((req, res, next) => {
  if (tokenEnabled && requiresToken(req) && !security.isAuthorized(req)) {
    res.status(401).json({ error: 'missing or invalid control token' });
    return;
  }
  next();
});
// Sensitive API responses must never be cached (SPRINT-2 A2).
app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) {
    res.setHeader('Cache-Control', 'no-store');
  }
  next();
});

// Data isolation: demo mode never touches ~/.pi and never spawns real pi.
const sessions =
  mode === 'demo' ? createMockSessionProvider() : createFileSessionProvider();
const hub = new SseHub();
const bridge = new RpcBridge(PI_BINARY, AGENT_CWD);

// P2-01: adapter surface — pi is the primary adapter (wraps the existing
// bridge); codex history is a read-only integration (rollout parse) that
// never spawns codex and never reads ~/.codex/auth.json.
const piAdapter = new PiAdapter(bridge);
// Node EventEmitter throws on unhandled 'error' — the adapter re-broadcasts
// bridge errors, so always attach a handler here.
piAdapter.on('error', (error) => {
  console.error(`[adapter:pi] ${error.message}`);
});
const adapters = [
  piAdapter.meta,
  {
    kind: 'codex' as const,
    label: 'Codex',
    version: 'read-only', // history integration; exec adapter is opt-in
    defaultColor: '#10a37f',
  },
];

/** Finds a codex rollout by session id (read-only, no spawn). */
async function parseRolloutFileById(id: string): Promise<CodexSessionDetail | null> {
  const sessionsList = await listCodexSessions();
  const match = sessionsList.find((session) => session.sessionId === id);
  if (match === undefined) {
    return null;
  }
  return parseRolloutFile(match.fileName);
}

// P1-15: track agent runs so a channel-config save can restart pi when idle
// (models.json is loaded once at process start) or defer the restart to the
// next settle. The panel re-switches to the session file before every prompt,
// so respawning pi does not detach the active session.
let agentRunning = false;
let modelReloadRequested = false;
const requestModelReload = (): 'reloaded' | 'deferred' => {
  if (mode === 'demo') {
    return 'reloaded';
  }
  if (agentRunning) {
    modelReloadRequested = true;
    return 'deferred';
  }
  if (bridge.isRunning()) {
    bridge.restart();
  }
  return 'reloaded';
};

bridge.on('event', (event) => {
  if (event.type === 'agent_start') {
    agentRunning = true;
  } else if (event.type === 'agent_end' || event.type === 'agent_settled') {
    agentRunning = false;
    if (modelReloadRequested) {
      modelReloadRequested = false;
      bridge.restart();
    }
  }
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
    if (event.type === 'message_update') {
      console.log(`[kMode:debug] message_update frame=${JSON.stringify(event).slice(0, 500)}`);
    } else {
      console.log(`[kMode:debug] event type=${event.type}`);
    }
  });
}
if (mode !== 'demo') {
  bridge.start();
}

const demoMachine = mode === 'demo' ? new DemoStateMachine(hub, sessions) : null;

// Pipelines (P1-02-C): demo mode uses a throwaway temp store so the showcase
// never writes PiHub-owned state on this machine; demo seeds show the surface
// (runs stay read-only via the 503 write guards).
const pipelineStore = createPipelineStore(
  mode === 'demo' ? mkdtempSync(path.join(os.tmpdir(), 'pihub-demo-')) : undefined,
);
if (mode === 'demo') {
  seedDemoPipelines(pipelineStore);
}
const pipelineEngine = mode === 'demo' ? null : new PipelineEngine(bridge, pipelineStore);
if (pipelineEngine !== null) {
  pipelineEngine.on('run-change', (run) => {
    hub.broadcast({ type: 'pipeline_step', run });
  });
}

app.use(
  createRouter(bridge, sessions, hub, {
    mode,
    demoMachine,
    pipelines: { store: pipelineStore, engine: pipelineEngine },
    reloadModels: requestModelReload,
    allowedRoot: AGENT_CWD,
    adapters: {
      list: () => adapters,
      // Read-only codex integration; demo keeps it empty (synthetic-only).
      ...(mode === 'demo'
        ? {}
        : {
            codexSessions: () => listCodexSessions(),
            codexSessionDetail: (id: string) =>
              parseRolloutFileById(id),
          }),
    },
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
// The per-process control token is injected into the served HTML (SPRINT-2 A1):
// the SPA reads window.__PIHUB_TOKEN__ and sends it as X-PiHub-Token on
// writes / sensitive reads, and as ?token= on the SSE EventSource.
const distDir = path.resolve(process.cwd(), 'dist');
const indexFile = path.join(distDir, 'index.html');
app.use((req, res, next) => {
  if (req.method === 'GET' && !req.path.startsWith('/api/')) {
    res.setHeader('Cache-Control', 'no-store');
  }
  next();
});
// Serve index.html ourselves (BEFORE express.static, which would otherwise
// short-circuit it) so the per-process control token can be injected.
app.use((req, res, next) => {
  if (req.method !== 'GET' || req.path.startsWith('/api/')) {
    next();
    return;
  }
  const wantsIndex = req.path === '/' || req.path === '/index.html';
  if (!wantsIndex) {
    next();
    return;
  }
  const sendHtml = async (): Promise<void> => {
    try {
      const { readFile } = await import('node:fs/promises');
      let html = await readFile(indexFile, 'utf8');
      if (tokenEnabled) {
        html = html.replace(
          '</head>',
          `<script>window.__PIHUB_TOKEN__=${JSON.stringify(security.token)};</script></head>`,
        );
      }
      res.type('html').send(html);
    } catch {
      res.status(404).json({
        error: 'frontend build not found — run `npm run build` or use the Vite dev server on port 18384',
      });
    }
  };
  void sendHtml();
});
app.use(express.static(distDir, { index: false }));

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
