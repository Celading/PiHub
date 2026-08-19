#!/usr/bin/env node
import express from 'express';
import path from 'node:path';
import { RpcBridge } from './rpc-bridge.js';
import { createRouter } from './routes.js';
import { createFileSessionProvider } from './providers/file-session-provider.js';
import { createMockSessionProvider } from './providers/mock-session-provider.js';
import { DemoStateMachine } from './demo/state-machine.js';
import { CodexAdapter, resolveCodexBinary } from './adapters/codex-adapter.js';
import { ClaudeExecAdapter, resolveClaudeBinary } from './adapters/claude-exec.js';
import { DshAdapter, resolveDshBinary } from './adapters/dsh-adapter.js';
import { backfillCodexSessions, listCodexSessionsFast } from './adapters/codex-history.js';
import { findClaudeTranscript, listClaudeSessions, parseClaudeDetail } from './adapters/claude-history.js';
import { DemoShowcase } from './demo/showcase.js';
import { SseHub } from './sse.js';
import { ExternalSessionWatcher } from './external-sessions.js';
import { DEFAULT_DSH_WEB_URL, DshWebRuntime } from './dsh-web-runtime.js';
import { listDshSessions } from './dsh-history.js';
import { createAgentsManager } from './agents.js';
import { PipelineEngine } from './pipelines/engine.js';
import { createPipelineStore } from './pipelines/store.js';
import { LeaseGate } from './pipelines/lease.js';
import { McpServer } from './mcp.js';
import { seedDemoPipelines } from './demo/demo-pipelines.js';
import { existsSync, mkdtempSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import {
  createJsonBodyMiddleware,
  createSecurityGate,
  LanGate,
  requiresToken,
} from './security.js';
import type { AgentMessage, RpcStreamEvent } from '../shared/types.js';
import { PiAdapter } from './adapters/pi-adapter.js';
import { listCodexSessions, parseRolloutFile, type CodexSessionDetail } from './adapters/codex-history.js';
import { getAtomcodeSession } from './adapters/atomcode-history.js';
import { listZcodeSessions, parseZcodeRollout, type ZcodeSessionDetail } from './adapters/zcode-history.js';
import { effectiveServerConfig, loadPihubConfig } from './config.js';
import { configFileOf, resolvePihubHome } from './pihub-home.js';
import { createSystemPromptStore } from './system-prompt.js';
import { buildRuntimeSurface, probeCapabilities } from './capabilities.js';
import { createWorkspaceSnapshotStore } from './workspace-snapshot.js';
import { gitStatus, isGitUnavailableError } from './git-status.js';

// PIHUB_HOME → ~/.pihub (fallback ./itData when no permission); config.toml
// inside it holds the server options. Env (PIHUB_PORT/PORT) wins over the
// file; the generic PORT is commonly injected by deployment platforms, so
// the dedicated variable takes precedence when both are present.
const pihubConfigPromise = loadPihubConfig();
const pihubHomePromise = resolvePihubHome();
const effectiveConfig = effectiveServerConfig(await pihubConfigPromise);
const PORT = effectiveConfig.port;
const HOST = effectiveConfig.host;
const PI_BINARY = process.env.PI_BINARY ?? 'pi';
const AGENT_CWD = process.env.PI_CWD ?? process.cwd();
/** Node binary used to spawn child runtime processes. */
const NODE_BIN = process.env.PIHUB_NODE_BIN ?? process.execPath;
/** A packaged Pi CLI may be a JavaScript entry rather than an executable.
 *  Run that entry through Node in interpreter mode when explicitly selected. */
const PI_BASE_ARGS =
  process.env.PIHUB_PI_CLI === PI_BINARY
    ? ['--jitless', PI_BINARY]
    : [];
const PI_EXECUTABLE = PI_BASE_ARGS.length > 0 ? NODE_BIN : PI_BINARY;
/** MCP bridge mode (`pihub --mcp`): expose the pipeline substrate over
 *  stdio (JSON-RPC) for hosts like dsh instead of serving HTTP. */
const isMcpMode = process.argv.includes('--mcp');

// kMode (KMODE-001 K2): runtime mode decided once at startup.
type PanelMode = 'production' | 'debug' | 'demo';
const rawMode = process.env.PIHUB_MODE ?? 'production';
const mode: PanelMode = rawMode === 'debug' || rawMode === 'demo' ? rawMode : 'production';

const app = express();
app.disable('x-powered-by');

// SPRINT-2 A1: local control-plane security gate. Host + Origin checks run
// for every request; the per-process control token is mandatory in
// production (injected into the served index.html, read back by the SPA for
// fetch headers; SSE uses an HttpOnly control cookie). Demo/debug keep Host/Origin gating
// but may disable the token via env — demo already has 503 write guards and
// synthetic data, and the dev tooling (vite origin + curl probes) must keep
// working.
const security = createSecurityGate();
const tokenEnabled = mode === 'production' || process.env.PIHUB_DEV_NO_TOKEN !== '1';
app.use(security.middleware.bind(security));
// P2-02/R0: LAN gate runs first. Remote peers exchange a one-use bootstrap
// for an independent HttpOnly cookie session; no LAN credential is accepted
// from a URL. Loopback traffic is untouched.
const lanGate = new LanGate();
app.use(lanGate.middleware.bind(lanGate));

app.use((req, res, next) => {
  // A validated remote cookie session satisfies the local-control-token
  // requirement. The bootstrap exchange is the only tokenless remote write;
  // its one-use secret is validated atomically by the route itself.
  const remoteSession = lanGate.isRemote(req) && lanGate.isAuthenticated(req);
  const remoteExchange = lanGate.isRemote(req) && lanGate.isSessionExchange(req);
  if (
    tokenEnabled &&
    requiresToken(req) &&
    !remoteSession &&
    !remoteExchange &&
    !security.isAuthorized(req)
  ) {
    res.status(401).json({ error: 'missing or invalid control token' });
    return;
  }
  next();
});
// Parse request bodies only after the security gates. The bootstrap exchange
// uses a narrow limit and fixed, non-reflective parse errors.
app.use(createJsonBodyMiddleware(lanGate));
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
lanGate.onSessionRevoked((sessionId) => {
  hub.closeRemoteSession(sessionId);
});
const bridge = new RpcBridge(PI_EXECUTABLE, AGENT_CWD, { baseArgs: PI_BASE_ARGS });

// P2-01: adapter surface — pi is the primary adapter (wraps the existing
// bridge); codex is now ACTIVE as the second exec adapter (per-prompt
// `codex exec --json --ephemeral` processes with resume; see
// codex-adapter.ts). It never reads ~/.codex/auth.json and never writes
// session files (ephemeral). Enabled in demo mode too? No — demo stays
// synthetic-only: the codex adapter is created for non-demo modes.
const piAdapter = new PiAdapter(bridge);
// Node EventEmitter throws on unhandled 'error' — the adapter re-broadcasts
// bridge errors, so always attach a handler here.
piAdapter.on('error', (error) => {
  console.error(`[adapter:pi] ${error.message}`);
});
const codexAdapter = mode === 'demo' ? null : new CodexAdapter(resolveCodexBinary(), AGENT_CWD);
if (codexAdapter !== null) {
  codexAdapter.on('error', (error) => {
    console.error(`[adapter:codex] ${error.message}`);
  });
  // Codex events stream through the same SSE hub; the `kind: 'codex'` mark
  // lets the frontend route them to the codex chat view.
  codexAdapter.on('event', (event) => {
    hub.broadcast(event);
  });
}
// Claude exec adapter: headless per-prompt conversation in the chat view
// (`claude -p --output-format json --continue`); transcripts stay read-only
// in history. Tool approval is interactive (never auto-granted).
const claudeAdapter = mode === 'demo' ? null : new ClaudeExecAdapter({ binaryPath: resolveClaudeBinary(), cwd: AGENT_CWD });
if (claudeAdapter !== null) {
  claudeAdapter.on('error', (error: Error) => {
    console.error(`[adapter:claude] ${error.message}`);
  });
  claudeAdapter.on('event', (event: RpcStreamEvent) => {
    hub.broadcast(event);
  });
}
// D2: dsh (DeepSeek Harness) as the embedded harness kernel — one task per
// `--profile headless` invocation with an isolated DSH_HOME.
// dsh is a first-class agent on EVERY form, like codex/claude: the adapter
// is always registered and availability follows the resolved binary
// from a locally installed `dsh` CLI. Demo mode keeps it disabled.
const dshBinary = resolveDshBinary();
const dshAdapter = mode === 'demo' ? null : new DshAdapter({
  binaryPath: dshBinary,
  nodeBin: NODE_BIN,
  ...(process.env.DSH_HOME !== undefined && process.env.DSH_HOME.length > 0
    ? { home: process.env.DSH_HOME }
    : {}),
  ...(process.env.PIHUB_DSH_PRELOAD !== undefined && process.env.PIHUB_DSH_PRELOAD.length > 0
    ? { preload: process.env.PIHUB_DSH_PRELOAD }
    : {}),
  cwd: AGENT_CWD,
});
if (dshAdapter !== null) {
  dshAdapter.on('error', (error) => {
    console.error(`[adapter:dsh] ${error.message}`);
  });
  // dsh events carry `kind: 'dsh'`; the SPA routes them to the dsh chat view.
  dshAdapter.on('event', (event) => {
    hub.broadcast(event);
  });
}
// External session watcher: tails pi/codex session files so terminal-side
// runs appear in the panel in near-real time (and the panel's own runs close
// the loop the other way via the same files). Custom homes override via env.
const externalWatcher = new ExternalSessionWatcher({
  ...(process.env.PIHUB_EXT_PI_DIR !== undefined ? { piDir: process.env.PIHUB_EXT_PI_DIR } : {}),
  ...(process.env.PIHUB_EXT_CODEX_DIR !== undefined ? { codexDir: process.env.PIHUB_EXT_CODEX_DIR } : {}),
  ...(process.env.PIHUB_EXT_DSH_DIR !== undefined ? { dshDir: process.env.PIHUB_EXT_DSH_DIR } : {}),
  onEvent: (event) => {
    hub.broadcast({ type: 'external_event', ...event });
  },
});
externalWatcher.start();
// DSH is a first-class local runtime: auto-discover the current Web gateway on
// 3080, retain manual/remote override support, and reconnect event sockets
// after a transient host restart. Headless one-shots remain the honest
// fallback while the gateway is unavailable.
let dshChatSessionId: string | null = null;
const dshWebRuntime = new DshWebRuntime({
  onFrame: (frame, rpcId) => {
    hub.broadcast({
      ...frame,
      frameType: (frame as { type?: unknown }).type,
      rpcId,
      type: 'dsh_web_event',
    });
  },
  onError: (error) => {
    console.error(`[dsh-web] events stream error: ${error.message}; reconnecting`);
  },
});
dshWebRuntime.start(process.env.PIHUB_DSH_WEB_URL ?? DEFAULT_DSH_WEB_URL);
const adapters = [
  piAdapter.meta,
  {
    kind: 'codex' as const,
    label: 'Codex',
    version: codexAdapter === null ? 'read-only' : 'exec (resume)',
    defaultColor: '#10a37f',
  },
  // dsh is a first-class agent on every form; availability follows the
  // resolved local binary and is reported by the capability route — the list never says
  // 'missing' (same convention as codex/claude).
  {
    kind: 'dsh' as const,
    label: 'DeepSeek Harness',
    version: dshAdapter === null ? 'read-only' : 'headless (built-in)',
    defaultColor: '#7c3aed',
  },
  {
    kind: 'claude' as const,
    label: 'Claude',
    version: claudeAdapter === null ? 'read-only' : 'exec (per-prompt)',
    defaultColor: '#d97757',
  },
  {
    kind: 'atomcode' as const,
    label: 'AtomCode',
    version: 'read-only', // exec adapter opt-in; history parsed read-only
    defaultColor: '#e4572e',
  },
  {
    kind: 'zcode' as const,
    label: 'ZCode',
    version: 'read-only', // host agent; record consumer only
    defaultColor: '#7f56d9',
  },
];

/** Finds a zcode rollout by session id (read-only, no spawn). */
async function findZcodeRolloutById(id: string): Promise<ZcodeSessionDetail | null> {
  const sessions = await listZcodeSessions();
  const match = sessions.find((session) => session.sessionId === id);
  if (match === undefined) {
    return null;
  }
  return parseZcodeRollout(match.fileName);
}

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
// Showcase sprint: the scripted demo conversation player (same SSE hub, so
// the typewriter / tool-chain collapse / final summary are all production
// components reacting to ordinary events).
const demoShowcase = mode === 'demo' ? new DemoShowcase(hub, sessions) : null;

// Pipelines (P1-02-C): demo mode uses a throwaway temp store so the showcase
// never writes PiHub-owned state on this machine; demo seeds show the surface
// (runs stay read-only via the 503 write guards).
const pihubHome = await pihubHomePromise;
const workspaceChanges = createWorkspaceSnapshotStore(
  path.join(pihubHome.dir, 'workspace-baselines'),
);
// Freeze the default non-Git workspace baseline before the HTTP surface is
// exposed. Git repositories keep Git as their sole source of truth.
if (mode !== 'demo') {
  try {
    const changes = await gitStatus(AGENT_CWD);
    if (changes === null) {
      await workspaceChanges.ensureBaseline(AGENT_CWD);
    }
  } catch (error) {
    if (isGitUnavailableError(error)) {
      await workspaceChanges.ensureBaseline(AGENT_CWD);
    } else {
      console.warn(`[workspace] baseline preflight skipped: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
// Agent management (panel-side startup/config): persists to agents.json in
// the panel home; binary overrides apply from the next panel restart, the pi
// bridge restart takes effect immediately.
const agentsManager = createAgentsManager({
  home: pihubHome.dir,
  resolveBinary: (kind) =>
    kind === 'pi'
      ? PI_BINARY
      : kind === 'codex'
        ? resolveCodexBinary()
        : kind === 'claude'
          ? resolveClaudeBinary()
          : resolveDshBinary(),
  restartPi: async () => {
    try {
      if (bridge.isRunning()) {
        bridge.restart();
      } else {
        bridge.start();
      }
      await bridge.waitReady(10_000);
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  },
  isPiRunning: () => bridge.isRunning(),
});
const pipelineStore = createPipelineStore(
  mode === 'demo' ? mkdtempSync(path.join(os.tmpdir(), 'pihub-demo-')) : pihubHome.dir,
);
if (mode === 'demo') {
  seedDemoPipelines(pipelineStore);
}
const pipelineEngine =
  mode === 'demo'
    ? null
    : new PipelineEngine(
        bridge,
        pipelineStore,
        undefined,
        new LeaseGate(pihubHome.dir),
        // Optional codex executor for agent=codex pipeline runs (per-prompt
        // `codex exec`; resolves when the turn settles).
        codexAdapter === null
          ? undefined
          : {
              prompt: async (message: string, opts?: { cwd?: string }) => {
                const response = await codexAdapter.send({
                  type: 'prompt',
                  message,
                  ...(opts?.cwd !== undefined ? { cwd: opts.cwd } : {}),
                });
                return { success: response.success, ...(typeof response.error === 'string' ? { error: response.error } : {}) };
              },
              abort: async () => {
                const response = await codexAdapter.send({ type: 'abort' });
                return response.success;
              },
            },
      );
if (pipelineEngine !== null) {
  pipelineEngine.on('run-change', (run) => {
    hub.broadcast({ type: 'pipeline_step', run });
  });
  // v1b: resume in-flight runs from the durable journal at boot.
  pipelineEngine.recover();
}
// MCP bridge mode: wire the pipeline substrate to stdio (JSON-RPC) for hosts
// like dsh. The HTTP app below stays inert (never listens) in this mode.
if (isMcpMode && pipelineEngine !== null) {
  const mcp = new McpServer({
    runPipeline: (pipelineId, input) => {
      const pipeline = pipelineStore.get(pipelineId);
      if (pipeline === undefined) {
        return { ok: false, error: 'pipeline not found' };
      }
      try {
        const run = pipelineEngine.start(pipeline, input, {});
        return { ok: true, run };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
    abortRun: (runId) => pipelineEngine.abort(runId),
    approveRun: (runId, approve) => pipelineEngine.approve(runId, approve),
    listPipelines: () =>
      pipelineStore
        .list()
        .map((p) => ({ id: p.id, name: p.name, stepCount: p.steps.length })),
    listReceipts: (pipelineId) => pipelineStore.listRunReceipts(pipelineId),
  });
  mcp.start();
  console.error('[mcp] pihub MCP bridge listening on stdio');
}

// Settings system prompt: `<home>/system-prompt.md`; saving restarts the pi
// runtime through the same idle/deferred path as a model-config reload (the
// RPC bridge reads the prompt at spawn time via --append-system-prompt).
const systemPromptStore = createSystemPromptStore({
  home: pihubHome.dir,
  reload: requestModelReload,
});

app.use(
  createRouter(bridge, sessions, hub, {
    mode,
    demoMachine,
    demoShowcase,
    pipelines: { store: pipelineStore, engine: pipelineEngine },
    reloadModels: requestModelReload,
    systemPrompt: {
      get: () => systemPromptStore.get(),
      save: (prompt) => systemPromptStore.save(prompt),
    },
    workspaceChanges,
    allowedRoot: AGENT_CWD,
    runtimeInfo: () => ({
      home: pihubHome.dir,
      configFile: configFileOf(pihubHome.dir),
      url: effectiveConfig.url,
    }),
    lanGate,
    codexExec:
      codexAdapter === null
        ? null
        : {
            prompt: async (message: string, cwd?: string) => {
              const response = await codexAdapter.send({
                type: 'prompt',
                message,
                ...(cwd !== undefined ? { cwd } : {}),
              });
              return {
                success: response.success,
                ...(typeof response.error === 'string' ? { error: response.error } : {}),
              };
            },
            abort: async () => {
              const response = await codexAdapter.send({ type: 'abort' });
              return { success: response.success };
            },
            state: async () => {
              const response = await codexAdapter.send({ type: 'get_state' });
              return {
                success: response.success,
                ...(response.data !== undefined
                  ? { data: response.data as { isStreaming: boolean; sessionId?: string | null } }
                  : {}),
              };
            },
            switchSession: async (sessionId: string) => {
              const response = await codexAdapter.send({ type: 'switch_session', sessionId });
              return {
                success: response.success,
                ...(typeof response.error === 'string' ? { error: response.error } : {}),
              };
            },
            messages: (threadId?: string) => codexAdapter.getMessages(threadId),
          },
    claudeExec:
      claudeAdapter === null
        ? null
        : {
            prompt: async (message: string, cwd?: string) => {
              const response = await claudeAdapter.send({
                type: 'prompt',
                message,
                ...(cwd !== undefined ? { cwd } : {}),
              });
              return {
                success: response.success,
                ...(typeof response.error === 'string' ? { error: response.error } : {}),
                ...(response.data !== undefined
                  ? { data: response.data as { answer?: string } }
                  : {}),
              };
            },
            abort: async () => {
              const response = await claudeAdapter.send({ type: 'abort' });
              return { success: response.success };
            },
            state: async () => {
              const response = await claudeAdapter.send({ type: 'get_state' });
              return {
                success: response.success,
                ...(response.data !== undefined
                  ? { data: response.data as { isStreaming: boolean } }
                  : {}),
              };
            },
            messages: () => Promise.resolve(claudeAdapter.getMessages() as unknown as AgentMessage[]),
          },
    dshExec:
      dshAdapter === null
        ? null
        : {
            prompt: async (message: string, cwd?: string) => {
              // Web-first routing: with a dsh web instance connected, the
              // chat drives a real session (continuity + streaming events
              // over the panel SSE); headless one-shots remain the fallback.
              const dshWebClient = dshWebRuntime.client();
              if (dshWebClient !== null) {
                let sessionId = dshChatSessionId;
                if (sessionId === null) {
                  const created = await dshWebClient.createSession(cwd);
                  if (!created.ok || typeof created.value !== 'object' || created.value === null) {
                    return {
                      success: false,
                      error: `dsh web session.create failed: ${created.error?.message ?? 'unknown'}`,
                    };
                  }
                  const value = created.value as { sessionId?: unknown };
                  if (typeof value.sessionId !== 'string') {
                    return { success: false, error: 'dsh web session.create returned no sessionId' };
                  }
                  sessionId = value.sessionId;
                  dshChatSessionId = sessionId;
                }
                const result = await dshWebClient.prompt(sessionId, message, 'queue');
                if (!result.ok) {
                  return { success: false, error: result.error?.message ?? 'dsh web prompt failed' };
                }
                return {
                  success: true,
                  data: { sessionId, mode: 'web' },
                };
              }
              const response = await dshAdapter.send({
                type: 'prompt',
                message,
                ...(cwd !== undefined ? { cwd } : {}),
              });
              return {
                success: response.success,
                ...(typeof response.error === 'string' ? { error: response.error } : {}),
                ...(response.data !== undefined
                  ? { data: response.data as { answer?: string } }
                  : {}),
              };
            },
            abort: async () => {
              const dshWebClient = dshWebRuntime.client();
              if (dshWebClient !== null && dshChatSessionId !== null) {
                const result = await dshWebClient.cancel(dshChatSessionId);
                return { success: result.ok };
              }
              const response = await dshAdapter.send({ type: 'abort' });
              return { success: response.success };
            },
            state: async () => {
              const dshWebClient = dshWebRuntime.client();
              if (dshWebClient !== null && dshChatSessionId !== null) {
                const sessions = await dshWebClient.listSessions();
                if (sessions.ok && typeof sessions.value === 'object' && sessions.value !== null) {
                  const items = (sessions.value as { items?: Array<{ sessionId?: unknown; running?: unknown }> }).items;
                  const row = items?.find((item) => item.sessionId === dshChatSessionId);
                  if (row !== undefined) {
                    return { success: true, data: { isStreaming: row.running === true } };
                  }
                }
              }
              const response = await dshAdapter.send({ type: 'get_state' });
              return {
                success: response.success,
                ...(response.data !== undefined
                  ? { data: response.data as { isStreaming: boolean } }
                  : {}),
              };
            },
            messages: () => Promise.resolve(dshAdapter.getMessages() as unknown as AgentMessage[]),
          },
    externalSessions: externalWatcher,
    dshSessions: () =>
      listDshSessions({
        webList: () => {
          const client = dshWebRuntime.client();
          if (client === null) {
            return Promise.resolve({ ok: false } as const);
          }
          return client.listSessions();
        },
      }),
    dshWeb: {
            status: () => dshWebRuntime.status(),
            connect: async (url: string) => {
              dshChatSessionId = null;
              const result = await dshWebRuntime.connect(url);
              return result;
            },
            disconnect: () => {
              dshChatSessionId = null;
              dshWebRuntime.disconnect();
            },
            listSessions: async (cursor?: string) => {
              const client = dshWebRuntime.client();
              if (client === null) {
                return { ok: false, error: 'dsh web not connected' };
              }
              const result = await client.listSessions(cursor);
              if (!result.ok) {
                return { ok: false, error: result.error?.message ?? 'session.list failed' };
              }
              return { ok: true, value: result.value };
            },
            history: async (sessionId: string) => {
              const client = dshWebRuntime.client();
              if (client === null) {
                return { ok: false, error: 'dsh web not connected' };
              }
              const result = await client.sessionHistory(sessionId);
              if (!result.ok) {
                return { ok: false, error: result.error?.message ?? 'session.history failed' };
              }
              return { ok: true, value: result.value };
            },
            prompt: async (sessionId: string, text: string, mode: 'queue' | 'steer') => {
              const client = dshWebRuntime.client();
              if (client === null) {
                return { ok: false, error: 'dsh web not connected' };
              }
              const result = await client.prompt(sessionId, text, mode);
              if (!result.ok) {
                return { ok: false, error: result.error?.message ?? 'session.prompt failed' };
              }
              return { ok: true, value: result.value };
            },
            cancel: async (sessionId: string) => {
              const client = dshWebRuntime.client();
              if (client === null) {
                return { ok: false, error: 'dsh web not connected' };
              }
              const result = await client.cancel(sessionId);
              if (!result.ok) {
                return { ok: false, error: result.error?.message ?? 'session.cancel failed' };
              }
              return { ok: true, value: result.value };
            },
            approvals: () => dshWebRuntime.pendingApprovals(),
            approve: async (
              rpcId: string,
              sessionId: string,
              approvalId: string,
              outcome: 'allowed-once' | 'rejected',
            ) => {
              const client = dshWebRuntime.client();
              if (client === null) {
                return { ok: false, error: 'dsh web not connected' };
              }
              const result = await client.respond(rpcId, sessionId, approvalId, outcome);
              if (!result.accepted) {
                return { ok: false, error: result.reason ?? 'approval not accepted' };
              }
              dshWebRuntime.resolveApproval(rpcId);
              return { ok: true };
            },
            createSession: async (cwd?: string) => {
              const client = dshWebRuntime.client();
              if (client === null) {
                return { ok: false, error: 'dsh web not connected' };
              }
              const result = await client.createSession(cwd);
              if (!result.ok) {
                return { ok: false, error: result.error?.message ?? 'session.create failed' };
              }
              return { ok: true, value: result.value };
            },
            models: async () => {
              const client = dshWebRuntime.client();
              if (client === null) {
                return { ok: false, error: 'dsh web not connected' };
              }
              const result = await client.models();
              if (!result.ok) {
                return { ok: false, error: result.error?.message ?? 'llm.models failed' };
              }
              return { ok: true, value: result.value };
            },
          },
    agents: agentsManager,
    adapters: {
      list: () => adapters,
      // Read-only integrations; demo keeps them empty (synthetic-only).
      ...(mode === 'demo'
        ? {}
        : {
            claudeSessions: () => listClaudeSessions(),
            claudeSessionDetail: async (id: string) => {
              const file = await findClaudeTranscript(id);
              return file === null ? [] : parseClaudeDetail(file);
            },
            codexSessions: () => {
              const fast = listCodexSessionsFast();
              // Newest-first fast list renders immediately; the heavy
              // backfill fills older placeholders in the background.
              void fast.then(() => backfillCodexSessions()).catch(() => {});
              return fast;
            },
            codexSessionDetail: (id: string) => parseRolloutFileById(id),
            atomcodeSession: () => getAtomcodeSession(),
            zcodeSessions: () => listZcodeSessions(),
            zcodeSessionDetail: (id: string) => findZcodeRolloutById(id),
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
    runtimeSurface: (): ReturnType<typeof buildRuntimeSurface> => {
      const runtime = probeCapabilities();
      const piRuntime = runtime.agents.find((entry) => entry.kind === 'pi');
      const dshRuntime = runtime.agents.find((entry) => entry.kind === 'dsh');
      const debug = {
        bridgeRunning: bridge.isRunning(),
        pendingRpcRequests: bridge.pendingRequestCount(),
        pendingUiRequests: bridge.getPendingUiRequests().map((request) => request.id),
        sseClients: hub.clientCount(),
        dshWebConnected: dshWebRuntime.status().connected,
      };
      return buildRuntimeSurface({
        mode,
        piBinary: piRuntime?.binary ?? '',
        piRunning: bridge.isRunning(),
        dshBinary: dshRuntime?.binary ?? '',
        dshRunning: dshAdapter?.isRunning() ?? false,
        debug,
      });
    },
  }),
);

// Production: serve the built SPA with an index.html fallback for client routes.
// When dist is absent (dev mode), return a JSON hint instead of a 500.
// The per-process control token is injected into the served HTML (SPRINT-2 A1):
// the SPA reads window.__PIHUB_TOKEN__ and sends it as X-PiHub-Token on
// writes / sensitive reads. SSE authenticates through an HttpOnly cookie.
// Published-bin safe dist resolution: the bin (dist-server/server/index.js)
// sits two levels under the package root, so the frontend build is ALWAYS
// at <pkg>/dist relative to this file — resolving from process.cwd() broke
// `npx pihub` / global installs run from any other directory (frontend 404).
// The tsx dev layout (server/index.ts) has the same relative shape. cwd
// remains as a fallback for exotic setups.
const pkgDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist');
const distDir = existsSync(pkgDist) ? pkgDist : path.resolve(process.cwd(), 'dist');
const indexFile = path.join(distDir, 'index.html');
app.use((req, res, next) => {
  if (req.method === 'GET' && !req.path.startsWith('/api/')) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
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
      // The per-process local control token is never exposed to a remote
      // renderer. Local EventSource authentication uses an HttpOnly cookie;
      // fetch keeps the injected header for backwards compatibility.
      if (tokenEnabled && !lanGate.isRemote(req)) {
        res.setHeader('Set-Cookie', security.cookie(req));
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
    _err: unknown,
    _req: express.Request,
    res: express.Response,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _next: express.NextFunction,
  ) => {
    console.error('[http] internal request failure');
    if (!res.headersSent) {
      res.status(500).json({ error: 'internal server error' });
    }
  },
);

const shutdown = (): void => {
  console.log('shutting down…');
  dshWebRuntime.close();
  bridge.stop();
  hub.close();
  setTimeout(() => {
    process.exit(0);
  }, 300);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

if (!isMcpMode) {
  app.listen(PORT, HOST, () => {
    console.log(`pi-panel server listening on http://${HOST}:${String(PORT)}`);
    console.log(`pi binary: ${PI_BINARY}`);
  });
}
