import { readFile, readdir, realpath, stat, unlink, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { lookup } from 'node:dns/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { z } from 'zod';
import * as dshSettings from './dsh-settings.js';
import type { ExternalSessionEntry } from './external-sessions.js';
import type { DshSessionRow } from './dsh-history.js';
import type { AgentKind, AgentManageRow } from './agents.js';
import { probeCapabilities, type RuntimeSurface } from './capabilities.js';

// Published version, read once from package.json. The module sits at
// different depths between dev (server/) and the compiled npm package
// (dist-server/server/), and the npm bin may run from any cwd — so walk up
// from the module file until a package.json is found.
function loadPackageVersion(): string {
  let dir = fileURLToPath(new URL('.', import.meta.url));
  for (let depth = 0; depth < 8; depth += 1) {
    try {
      const pkg = JSON.parse(
        readFileSync(path.join(dir, 'package.json'), 'utf8'),
      ) as { version?: unknown };
      if (typeof pkg.version === 'string') {
        return pkg.version;
      }
    } catch {
      // keep walking up
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  return '0.0.0';
}
const PKG_VERSION = loadPackageVersion();
/** Build identity: YYMMDD + deployment channel. */
export function buildStamp(now = new Date()): string {
  const y = String(now.getFullYear()).slice(2);
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}
export function buildChannel(): string {
  const fromEnv = process.env.PIHUB_CHANNEL;
  if (fromEnv !== undefined && fromEnv.length > 0) {
    return fromEnv;
  }
  return 'server';
}
import {
  modelStoreFileSchema,
  pipelineApproveBodySchema,
  pipelineConvertBodySchema,
  pipelineRunBodySchema,
  pipelineUpsertBodySchema,
  settingsFileSchema,
  uiRespondBodySchema,
} from '../shared/schemas.js';
import type { RpcBridge } from './rpc-bridge.js';
import type { DemoStateMachine } from './demo/state-machine.js';
import type { AgentMessage } from '../shared/types.js';
import type { DemoShowcase } from './demo/showcase.js';
import { collectPrompts } from './prompts.js';
import { DEMO_RUNNING_ID } from './providers/mock-session-provider.js';
import type { PipelineRunRecord, RpcResponse, PiCommand } from '../shared/types.js';
import type { SessionStore } from './sessions.js';
import { parseSessionFile } from './sessions.js';
import { recentFileActions } from './recent-files.js';
import { gitDiff, gitStatus, isGitUnavailableError } from './git-status.js';
import {
  PiSettingsValidationError,
  readPiSettings,
  savePiSettings,
} from './pi-settings.js';
import type { WorkspaceSnapshotStore } from './workspace-snapshot.js';
import type { SseHub } from './sse.js';
import type { PipelineEngine } from './pipelines/engine.js';
import type { CodexSessionDetail } from './adapters/codex-history.js';
import type { AtomcodeSessionDetail } from './adapters/atomcode-history.js';
import type { ZcodeSessionDetail, ZcodeSessionMeta } from './adapters/zcode-history.js';
import type { LanGate } from './security.js';
import type { PipelineStore } from './pipelines/store.js';
import { hardConvert, softConvert } from './pipelines/convert.js';

const AGENT_DIR = path.join(os.homedir(), '.pi', 'agent');

const promptImageSchema = z.object({
  type: z.literal('image'),
  data: z.string(),
  mimeType: z.string().optional(),
});

/* ---- P2-2: SSRF guard for /api/models/fetch ---- */

/** True for loopback / private / link-local / metadata IPv4 or IPv6. */
export function isPrivateIp(ip: string): boolean {
  if (
    ip.startsWith('127.') ||
    ip.startsWith('10.') ||
    ip.startsWith('192.168.') ||
    ip.startsWith('169.254.') ||
    ip.startsWith('0.') ||
    ip === '::1' ||
    ip.startsWith('fe80:') ||
    ip.startsWith('fc') ||
    ip.startsWith('fd')
  ) {
    return true;
  }
  const m = /^172\.(\d+)\./u.exec(ip);
  if (m !== null) {
    const second = Number(m[1]);
    if (second >= 16 && second <= 31) {
      return true; // 172.16.0.0/12
    }
  }
  return false;
}

/**
 * P2-2: /api/models/fetch must never send the channel API key to a
 * non-public host (SSRF). Resolves the hostname and rejects when any
 * address is loopback/private/link-local (covers cloud metadata
 * 169.254.169.254). DNS-rebinding is bounded: the lookup happens right
 * before the fetch and the fetch uses the same hostname.
 */
export async function assertPublicUrl(rawUrl: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error('invalid URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('only http/https URLs are allowed');
  }
  if (parsed.hostname.length === 0) {
    throw new Error('missing hostname');
  }
  const addresses = await lookup(parsed.hostname, { all: true });
  if (addresses.length === 0) {
    throw new Error(`no addresses for ${parsed.hostname}`);
  }
  for (const { address } of addresses) {
    if (isPrivateIp(address)) {
      throw new Error(`blocked non-public host: ${parsed.hostname}`);
    }
  }
}

const promptBodySchema = z.object({
  message: z.string().min(1).max(32_000),
  streamingBehavior: z.enum(['steer', 'followUp']).optional(),
  images: z.array(promptImageSchema).max(8).optional(),
});

const steerBodySchema = z.object({
  message: z.string().min(1).max(32_000),
});

const modelBodySchema = z.object({
  provider: z.string().min(1),
  modelId: z.string().min(1),
});

const thinkingBodySchema = z.object({
  level: z.enum(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']),
});

const switchSessionBodySchema = z.object({
  sessionPath: z.string().min(1).max(4096),
});

const forkBodySchema = z.object({
  entryId: z.string().min(1).max(256),
});

const renameBodySchema = z.object({
  name: z.string().max(256),
});

const bashBodySchema = z.object({
  command: z.string().min(1).max(4096),
});

const autoCompactionBodySchema = z.object({
  enabled: z.boolean(),
});

const saveModelBodySchema = z.object({
  provider: z.string().min(1).max(128),
  modelId: z.string().min(1).max(256),
});

async function readJson(fileName: string): Promise<unknown> {
  try {
    const content = await readFile(fileName, 'utf8');
    return JSON.parse(content) as unknown;
  } catch {
    return undefined;
  }
}

/** Bounded recursive search for a session file by bare name (sessions are
 *  grouped under cwd-named subdirectories). Depth cap keeps the traversal
 *  local to the sessions tree. */
async function findSessionFile(
  root: string,
  bareName: string,
  depth = 0,
): Promise<string | null> {
  if (depth > 2) {
    return null;
  }
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      const found = await findSessionFile(full, bareName, depth + 1);
      if (found !== null) {
        return found;
      }
    } else if (entry.name === bareName) {
      return full;
    }
  }
  return null;
}

/** Runs an RPC command and maps success/failure/exception to clean HTTP codes. */
async function withBridge(
  res: express.Response,
  command: () => Promise<RpcResponse>,
): Promise<void> {
  try {
    const response = await command();
    if (!response.success) {
      res.status(502).json({ error: response.error ?? 'pi command failed' });
      return;
    }
    // pi often returns { success: true } with no data (e.g. prompt accept).
    // Express res.json(undefined) writes an empty body → frontend JSON parse fails.
    res.json(response.data ?? {});
  } catch (error) {
    res.status(502).json({ error: error instanceof Error ? error.message : String(error) });
  }
}

/** kMode router options (KMODE-001 K2/K4/K6). */
export interface RouterModeOptions {
  mode: 'production' | 'debug' | 'demo';
  demoMachine?: DemoStateMachine | null;
  /** Showcase sprint: scripted demo conversation player (demo mode only). */
  demoShowcase?: DemoShowcase | null;
  /** Codex exec adapter (ACTIVE 2026-08-12): per-prompt `codex exec` with
   *  resume; null in demo mode (synthetic-only). */
  codexExec?: {
    prompt: (message: string, cwd?: string) => Promise<{ success: boolean; error?: string }>;
    abort: () => Promise<{ success: boolean }>;
    state: () => Promise<{ success: boolean; data?: { isStreaming: boolean; sessionId?: string | null } }>;
    switchSession: (sessionId: string) => Promise<{ success: boolean; error?: string }>;
    messages: (threadId?: string) => Promise<AgentMessage[]>;
  } | null;
  /** dsh (DeepSeek Harness) embedded kernel (D2): one task per headless run,
   *  or a real web session when a dsh web instance is connected. */
  dshExec?: {
    prompt: (
      message: string,
      cwd?: string,
    ) => Promise<{
      success: boolean;
      error?: string;
      data?: { answer?: string; sessionId?: string; mode?: string };
    }>;
    abort: () => Promise<{ success: boolean }>;
    state: () => Promise<{ success: boolean; data?: { isStreaming: boolean } }>;
    messages: () => Promise<AgentMessage[]>;
  } | null;
  /** Claude exec adapter (headless per-prompt conversation). */
  claudeExec?: {
    prompt: (message: string, cwd?: string) => Promise<{ success: boolean; error?: string; data?: { answer?: string } }>;
    abort: () => Promise<{ success: boolean }>;
    state: () => Promise<{ success: boolean; data?: { isStreaming: boolean } }>;
    messages: () => Promise<AgentMessage[]>;
  } | null;
  /** External session watcher (terminal pi/codex/dsh ↔ panel shared stream). */
  externalSessions?: {
    list: (limit?: number) => ExternalSessionEntry[];
  };
  /** dsh web integration (stage 3): real-time dsh sessions over /api RPC. */
  dshWeb?: {
    status: () => {
      connected: boolean;
      state: 'connected' | 'connecting' | 'reconnecting' | 'disconnected';
      url: string | null;
      protocol: 'dsh-web-rpc-v1';
      describe: unknown;
      lastError: string | null;
    };
    connect: (url: string) => Promise<{ ok: boolean; error?: string }>;
    disconnect: () => void;
    listSessions: (cursor?: string) => Promise<{ ok: boolean; value?: unknown; error?: string }>;
    history: (sessionId: string) => Promise<{ ok: boolean; value?: unknown; error?: string }>;
    prompt: (
      sessionId: string,
      text: string,
      mode: 'queue' | 'steer',
    ) => Promise<{ ok: boolean; value?: unknown; error?: string }>;
    cancel: (sessionId: string) => Promise<{ ok: boolean; value?: unknown; error?: string }>;
    approvals: () => unknown[];
    approve: (
      rpcId: string,
      sessionId: string,
      approvalId: string,
      outcome: 'allowed-once' | 'rejected',
    ) => Promise<{ ok: boolean; error?: string }>;
    createSession: (cwd?: string) => Promise<{ ok: boolean; value?: unknown; error?: string }>;
    models: () => Promise<{ ok: boolean; value?: unknown; error?: string }>;
  };
  /** dsh session history (auto-discovered in the sessions view). */
  dshSessions?: () => Promise<DshSessionRow[]>;
  /** Panel-side agent management (startup/config). */
  agents?: {
    list: () => AgentManageRow[];
    configure: (kind: AgentKind, patch: { binary?: string; enabled?: boolean }) => { success: boolean; error?: string };
    restartPi: () => Promise<{ success: boolean; error?: string }>;
    installPlan: (kind: AgentKind) => { command: string[]; label: string } | null;
    install: (kind: AgentKind) => Promise<{ success: boolean; error?: string }>;
    installStatus: (kind: AgentKind) => {
      plan: { command: string[]; label: string } | null;
      running: boolean;
      exit: number | null;
      output: string;
    };
  };
  debugState?: () => Record<string, unknown>;
  /** Sanitized engine/service readiness used by the dashboard and session gate. */
  runtimeSurface?: () => RuntimeSurface;
  /** Pipelines surface (P1-02-C). Engine may be absent (demo seeds only). */
  pipelines?: {
    store: PipelineStore;
    engine: PipelineEngine | null;
  };
  /**
   * P1-15: restart the pi child after a channel-config save so the new
   * models.json is composed (pi loads it once per process). Returns
   * 'reloaded' when the runtime was (or will be by next spawn) fresh, or
   * 'deferred' when the reload waits for the current agent run to settle.
   */
  reloadModels?: () => 'reloaded' | 'deferred';
  /** P1-03: workspace root the file preview may read from (cwd subtree). */
  allowedRoot?: string;
  /** P1-08c: runtime info surfaced by /api/health (home dir, config file, url). */
  runtimeInfo?: () => { home?: string; configFile?: string | null; url?: string };
  /** Settings system prompt (owner spec): preview + edit + save; saving
   *  restarts the pi runtime so the next spawn appends the prompt. */
  systemPrompt?: {
    get: () => Promise<string>;
    save: (prompt: string) => Promise<{ success: boolean; error?: string }>;
  };
  /** Read-only workspace change fallback for hosts without a Git binary. */
  workspaceChanges?: WorkspaceSnapshotStore;
  /**
   * P2-01: registered agent adapters (metadata + codex history surface).
   * `codexHistory` is the read-only integration (rollout parse); it is
   * optional so demo mode stays synthetic.
   */
  adapters?: {
    list: () => Array<{ kind: string; label: string; version: string | null; defaultColor: string }>;
    codexSessions?: () => Promise<unknown[]>;
    claudeSessions?: () => Promise<unknown[]>;
    claudeSessionDetail?: (id: string) => Promise<unknown[]>;
    codexSessionDetail?: (id: string) => Promise<CodexSessionDetail | null>;
    /** ADAPTER2: atomcode + zcode read-only history surfaces. */
    atomcodeSession?: () => Promise<AtomcodeSessionDetail | null>;
    zcodeSessions?: () => Promise<ZcodeSessionMeta[]>;
    zcodeSessionDetail?: (id: string) => Promise<ZcodeSessionDetail | null>;
  };
  /** P2-02: LAN access modes + capability scope. */
  lanGate?: LanGate;
}

/** P1-17 C: normalize provider `/models` responses (OpenAI `data[]`,
 *  Anthropic `data[]` with display_name, Gemini `models[]` with
 *  `models/…` names) into catalog-style entries. */
function normalizeChannelModels(data: unknown): Array<{ id: string; name?: string }> {
  if (typeof data !== 'object' || data === null) {
    return [];
  }
  const record = data as Record<string, unknown>;
  const list = Array.isArray(record['data'])
    ? (record['data'] as unknown[])
    : Array.isArray(record['models'])
      ? (record['models'] as unknown[])
      : [];
  const out: Array<{ id: string; name?: string }> = [];
  for (const raw of list) {
    if (typeof raw !== 'object' || raw === null) {
      continue;
    }
    const entry = raw as Record<string, unknown>;
    if (typeof entry['id'] === 'string' && entry['id'].length > 0) {
      const name =
        typeof entry['display_name'] === 'string'
          ? entry['display_name']
          : typeof entry['displayName'] === 'string'
            ? entry['displayName']
            : undefined;
      out.push({ id: entry['id'], ...(name !== undefined ? { name } : {}) });
    } else if (typeof entry['name'] === 'string' && entry['name'].startsWith('models/')) {
      out.push({
        id: entry['name'].slice('models/'.length),
        ...(typeof entry['displayName'] === 'string' ? { name: entry['displayName'] } : {}),
      });
    }
  }
  return out;
}

export function createRouter(
  bridge: RpcBridge,
  sessions: SessionStore,
  hub: SseHub,
  options?: RouterModeOptions,
): express.Router {
  const router = express.Router();
  const mode = options?.mode ?? 'production';
  const demoMachine = options?.demoMachine ?? null;
  const demoShowcase = options?.demoShowcase ?? null;

  // Demo mode is a read-only showcase: guard every RPC write path.
  const writeDenied = (res: express.Response): boolean => {
    if (mode !== 'demo') {
      return false;
    }
    res.status(503).json({ error: 'demo mode: read-only showcase, RPC writes disabled' });
    return true;
  };

  // P2-02 B: remote peers (non-loopback) are read-only by default. Writes
  // require the operator to have enabled the matching capability.
  const remoteWriteDenied = (
    req: express.Request,
    res: express.Response,
    route: 'approve' | 'prompt' | 'shell',
  ): boolean => {
    if (lanGate === undefined || !lanGate.isRemote(req)) {
      return false;
    }
    if (lanGate.remoteCan(req, route)) {
      return false;
    }
    res.status(403).json({ error: 'remote write requires capability: enable it in settings' });
    return true;
  };

  router.get('/api/mode', (_req, res) => {
    res.json({ mode });
  });

  // Demo driver surface (P2-2 red-line alignment): these routes exist ONLY in
  // demo mode (demoMachine !== null) and drive the SYNTHETIC demo state
  // machine — they are the showcase's own control plane, not outward API
  // writes. Every outward write route still 503s in demo mode via
  // writeDenied(); /api/demo/* is the documented exemption and never touches
  // real sessions or real pi.
  if (demoMachine !== null) {
    router.get('/api/demo/state', (_req, res) => {
      // The showcase player supersedes the step-machine for the scripted
      // conversation; report its phase when present.
      res.json({ phase: demoShowcase?.getPhase() ?? demoMachine.getPhase() });
    });
    router.post('/api/demo/start', (_req, res) => {
      res.json({ phase: demoMachine.start() });
    });
    router.post('/api/demo/step', (_req, res) => {
      res.json({ phase: demoMachine.step() });
    });
    router.post('/api/demo/abort', (_req, res) => {
      res.json({ phase: demoMachine.abort() });
    });
    router.post('/api/demo/reset', (_req, res) => {
      res.json({ phase: demoMachine.reset() });
    });
    router.post('/api/demo/play', (_req, res) => {
      res.json({ phase: demoShowcase?.play() ?? 'idle' });
    });
    router.post('/api/demo/stop', (_req, res) => {
      res.json({ phase: demoShowcase?.stop() ?? 'idle' });
    });
  }

  if (mode === 'debug') {
    router.get('/api/debug/state', (_req, res) => {
      res.json(options?.debugState?.() ?? {});
    });
  }

  router.get('/api/runtime/capabilities', (_req, res) => {
    res.json(options?.runtimeSurface?.() ?? {
      mode,
      checkedAt: new Date().toISOString(),
      engines: [],
      services: [],
      defaultEngine: 'pi',
      fallbackEngine: 'dsh',
      debug: null,
    });
  });

  router.get('/api/health', (_req, res) => {
    res.json({
      status: 'ok',
      name: 'pihub',
      version: PKG_VERSION,
      // Internal build identity for the version barcode + About (no public
      // versioning impact): e.g. 0.3.0 · 260814.server
      build: `${buildStamp()}.${buildChannel()}`,
      time: new Date().toISOString(),
      ...(options?.runtimeInfo !== undefined ? options.runtimeInfo() : {}),
    });
  });

  router.get('/api/sessions', async (_req, res) => {
    const list = await sessions.list();
    res.json({ sessions: list });
  });

  // Session deletion (no pi RPC): only a bare .jsonl file name is accepted
  // (path-traversal guard). Sessions live under cwd-named subdirectories, so
  // the file is located by a bounded recursive search.
  router.post('/api/sessions/delete', async (req, res) => {
    if (writeDenied(res) || remoteWriteDenied(req, res, 'prompt')) {
      return;
    }
    const body = req.body as Record<string, unknown> | null;
    const fileName =
      typeof body === 'object' && body !== null ? body['fileName'] : undefined;
    if (typeof fileName !== 'string' || fileName.length === 0) {
      res.status(400).json({ error: 'invalid session file' });
      return;
    }
    const base = path.basename(fileName);
    if (base !== fileName || !base.endsWith('.jsonl')) {
      res.status(400).json({ error: 'invalid session file' });
      return;
    }
    const sessionsRoot = path.join(os.homedir(), '.pi', 'agent', 'sessions');
    const target = await findSessionFile(sessionsRoot, base);
    if (target === null) {
      res.status(404).json({ error: 'session file not found' });
      return;
    }
    try {
      await unlink(target);
      res.json({ success: true });
    } catch (error) {
      res.status(502).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  router.get('/api/sessions/:id', async (req, res) => {
    const detail = await sessions.get(req.params.id);
    if (detail === null) {
      res.status(404).json({ error: 'session not found' });
      return;
    }
    res.json(detail);
  });

  router.get('/api/stats', async (_req, res) => {
    const stats = await sessions.stats();
    res.json(stats);
  });

  router.get('/api/settings', async (_req, res) => {
    const raw = await readJson(path.join(AGENT_DIR, 'settings.json'));
    const parsed = settingsFileSchema.safeParse(raw);
    res.json(parsed.success ? parsed.data : {});
  });

  // Dedicated Pi Agent settings surface. It reads/writes settings.json only;
  // auth.json is neither opened nor represented by this contract.
  router.get('/api/pi-agent/settings', async (_req, res) => {
    try {
      const capabilities = probeCapabilities();
      const runtime = capabilities.agents.find((entry) => entry.kind === 'pi') ?? null;
      res.json({
        settings: await readPiSettings(AGENT_DIR),
        workspace: options?.allowedRoot ?? null,
        agentHome: AGENT_DIR,
        settingsFile: path.join(AGENT_DIR, 'settings.json'),
        nodeVersion: capabilities.nodeVersion,
        privateSpace: capabilities.privateSpace,
        runtime,
        managed: options?.agents?.list().find((entry) => entry.kind === 'pi') ?? null,
      });
    } catch (error) {
      res.status(502).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.put('/api/pi-agent/settings', async (req, res) => {
    if (writeDenied(res)) {
      return;
    }
    const body = req.body as { settings?: unknown } | null;
    const value = typeof body === 'object' && body !== null ? body.settings : undefined;
    try {
      const settings = await savePiSettings(AGENT_DIR, value);
      const reload = options?.reloadModels?.() ?? 'reloaded';
      res.json({ success: true, settings, reload });
    } catch (error) {
      const status = error instanceof PiSettingsValidationError ? 400 : 502;
      res.status(status).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  // Settings system prompt: preview + edit + save (owner spec). The store
  // lives in the PiHub home; saving restarts pi so the next spawn appends it
  // via --append-system-prompt. PUT is a write → demo 503.
  const systemPrompt = options?.systemPrompt;
  router.get('/api/system-prompt', async (_req, res) => {
    if (systemPrompt === undefined) {
      res.status(503).json({ error: 'system prompt unavailable' });
      return;
    }
    res.json({ prompt: await systemPrompt.get() });
  });
  router.put('/api/system-prompt', async (req, res) => {
    if (writeDenied(res)) {
      return;
    }
    if (systemPrompt === undefined) {
      res.status(503).json({ error: 'system prompt unavailable' });
      return;
    }
    const body = req.body as { prompt?: unknown } | null;
    const prompt = typeof body === 'object' && body !== null ? body['prompt'] : undefined;
    if (typeof prompt !== 'string') {
      res.status(400).json({ error: 'prompt must be a string' });
      return;
    }
    const result = await systemPrompt.save(prompt);
    if (!result.success) {
      res.status(500).json({ error: result.error ?? 'system prompt save failed' });
      return;
    }
    res.json({ success: true });
  });

  router.get('/api/models', async (_req, res) => {
    const raw = await readJson(path.join(AGENT_DIR, 'models-store.json'));
    const parsed = modelStoreFileSchema.safeParse(raw);
    if (!parsed.success) {
      res.json({ providers: [] });
      return;
    }
    const providers = Object.entries(parsed.data).map(([name, entry]) => ({
      provider: name,
      models: entry.models,
    }));
    res.json({ providers });
  });

  /* ---- P2-02: LAN access + capability scope ----
   * Pairing codes and capability switches are managed locally; remote peers
   * (non-loopback Host) are gated by the LanGate middleware and can only use
   * capabilities the operator enabled. */
  const lanGate = options?.lanGate;
  router.get('/api/net', (_req, res) => {
    res.json(
      lanGate === undefined
        ? { mode: 'local', caps: { remoteApprove: false, remotePrompt: false, remoteShell: false } }
        : { mode: lanGate.mode, caps: lanGate.caps, pairs: lanGate.listPairs() },
    );
  });
  router.post('/api/net/pair', (_req, res) => {
    if (lanGate === undefined || lanGate.mode === 'local') {
      res.status(503).json({ error: 'pairing disabled in local mode' });
      return;
    }
    res.json({ code: lanGate.createPairCode() });
  });
  router.post('/api/net/pair/revoke', (req, res) => {
    if (lanGate === undefined) {
      res.status(503).json({ error: 'pairing disabled' });
      return;
    }
    const body = req.body as Record<string, unknown> | null;
    const code = typeof body === 'object' && body !== null ? body['code'] : undefined;
    if (typeof code !== 'string' || code.length === 0) {
      res.status(400).json({ error: 'invalid pair code' });
      return;
    }
    lanGate.revoke(code);
    res.json({ success: true });
  });
  router.post('/api/net/caps', (req, res) => {
    if (lanGate === undefined) {
      res.status(503).json({ error: 'capability scope disabled' });
      return;
    }
    const body = req.body as Record<string, unknown> | null;
    const key = typeof body === 'object' && body !== null ? body['key'] : undefined;
    const value = typeof body === 'object' && body !== null ? body['value'] : undefined;
    if (
      (key !== 'remoteApprove' && key !== 'remotePrompt' && key !== 'remoteShell') ||
      typeof value !== 'boolean'
    ) {
      res.status(400).json({ error: 'invalid capability switch' });
      return;
    }
    lanGate.setCap(key, value);
    res.json({ success: true, caps: lanGate.caps });
  });

  /* ---- P2-01: agent adapters (metadata + codex read-only history) ---- */
  router.get('/api/adapters', (_req, res) => {
    res.json({ adapters: options?.adapters?.list() ?? [] });
  });

  /* ---- codex exec adapter (ACTIVE 2026-08-12) ---- */
  const codexExec = options?.codexExec ?? null;

  router.get('/api/claude/sessions/:id', async (req, res) => {
    const fn = options?.adapters?.claudeSessionDetail;
    if (fn === undefined) {
      res.json({ turns: [] });
      return;
    }
    try {
      res.json({ turns: await fn(req.params.id) });
    } catch (error) {
      res.status(502).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.get('/api/prompts', async (req, res) => {
    try {
      const q = typeof req.query['q'] === 'string' ? req.query['q'] : undefined;
      const agent = typeof req.query['agent'] === 'string' ? req.query['agent'] : undefined;
      const limitRaw = typeof req.query['limit'] === 'string' ? Number(req.query['limit']) : NaN;
      const records = await collectPrompts({
        ...(q !== undefined ? { q } : {}),
        ...(agent !== undefined ? { agent } : {}),
        ...(Number.isFinite(limitRaw) ? { limit: limitRaw } : {}),
      });
      res.json({ prompts: records });
    } catch (error) {
      res.status(502).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.get('/api/claude/sessions', async (_req, res) => {
    const fn = options?.adapters?.claudeSessions;
    if (fn === undefined) {
      res.json({ sessions: [] });
      return;
    }
    try {
      res.json({ sessions: await fn() });
    } catch (error) {
      res.status(502).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.get('/api/codex/state', async (_req, res) => {
    if (codexExec === null) {
      res.status(503).json({ error: 'codex exec disabled (demo mode)' });
      return;
    }
    const response = await codexExec.state();
    res.json({
      running: response.success && response.data?.isStreaming === true,
      sessionId: response.success ? (response.data?.sessionId ?? null) : null,
    });
  });

  router.post('/api/codex/prompt', async (req, res) => {
    if (codexExec === null) {
      res.status(503).json({ error: 'codex exec disabled (demo mode)' });
      return;
    }
    const message = (req.body as { message?: unknown }).message;
    if (typeof message !== 'string' || message.trim().length === 0) {
      res.status(400).json({ error: 'message is required' });
      return;
    }
    // Optional per-prompt working directory (chosen folder for the session).
    let cwd: string | undefined;
    const rawCwd = (req.body as { cwd?: unknown }).cwd;
    if (typeof rawCwd === 'string' && rawCwd.trim().length > 0) {
      const target = path.resolve(rawCwd.trim());
      const statResult = await stat(target).catch(() => null);
      if (statResult === null || !statResult.isDirectory()) {
        res.status(400).json({ error: `directory not found: ${target}` });
        return;
      }
      cwd = target;
    }
    const response = await codexExec.prompt(message.trim(), cwd);
    if (!response.success) {
      res.status(409).json({ error: response.error ?? 'codex rejected the prompt' });
      return;
    }
    res.json({ success: true });
  });

  router.post('/api/codex/abort', async (_req, res) => {
    if (codexExec === null) {
      res.status(503).json({ error: 'codex exec disabled (demo mode)' });
      return;
    }
    await codexExec.abort();
    res.json({ success: true });
  });

  router.get('/api/codex/messages', async (req, res) => {
    if (codexExec === null) {
      res.status(503).json({ error: 'codex exec disabled (demo mode)' });
      return;
    }
    const thread = typeof req.query['thread'] === 'string' ? req.query['thread'] : undefined;
    const messages = await codexExec.messages(thread);
    res.json({ messages });
  });

  router.post('/api/codex/session', async (req, res) => {
    if (codexExec === null) {
      res.status(503).json({ error: 'codex exec disabled (demo mode)' });
      return;
    }
    const sessionId = (req.body as { sessionId?: unknown }).sessionId;
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      res.status(400).json({ error: 'sessionId is required' });
      return;
    }
    const response = await codexExec.switchSession(sessionId);
    if (!response.success) {
      res.status(409).json({ error: response.error ?? 'codex rejected the session switch' });
      return;
    }
    res.json({ success: true });
  });
  /* ---- dsh (DeepSeek Harness) embedded kernel (D2) ---- */
  const dshExec = options?.dshExec ?? null;

  router.post('/api/dsh/prompt', async (req, res) => {
    if (dshExec === null) {
      res.status(503).json({ error: 'dsh kernel disabled (demo mode)' });
      return;
    }
    const message = (req.body as { message?: unknown }).message;
    if (typeof message !== 'string' || message.trim().length === 0) {
      res.status(400).json({ error: 'message is required' });
      return;
    }
    let cwd: string | undefined;
    const rawCwd = (req.body as { cwd?: unknown }).cwd;
    if (typeof rawCwd === 'string' && rawCwd.trim().length > 0) {
      const target = path.resolve(rawCwd.trim());
      const statResult = await stat(target).catch(() => null);
      if (statResult === null || !statResult.isDirectory()) {
        res.status(400).json({ error: `directory not found: ${target}` });
        return;
      }
      cwd = target;
    }
    const response = await dshExec.prompt(message.trim(), cwd);
    if (!response.success) {
      res.status(409).json({ error: response.error ?? 'dsh rejected the task' });
      return;
    }
    res.json({ success: true, ...(response.data !== undefined ? { data: response.data } : {}) });
  });

  router.post('/api/dsh/abort', async (_req, res) => {
    if (dshExec === null) {
      res.status(503).json({ error: 'dsh kernel disabled (demo mode)' });
      return;
    }
    await dshExec.abort();
    res.json({ success: true });
  });

  router.get('/api/dsh/state', async (_req, res) => {
    if (dshExec === null) {
      res.status(503).json({ error: 'dsh kernel disabled (demo mode)' });
      return;
    }
    const response = await dshExec.state();
    res.json({ running: response.data?.isStreaming ?? false });
  });

  router.get('/api/dsh/messages', async (_req, res) => {
    if (dshExec === null) {
      res.status(503).json({ error: 'dsh kernel disabled (demo mode)' });
      return;
    }
    const messages = await dshExec.messages();
    res.json({ messages });
  });

  /* ---- dsh embedded kernel settings (D2) ---- */
  // The gateway provider rides the user-patch layer (dsh --patch); these
  // endpoints read/write that file so the settings page can switch models
  // without touching credentials (the key stays an env reference).
  router.get('/api/dsh/settings', (_req, res) => {
    if (dshExec === null) {
      res.status(503).json({ error: 'dsh kernel disabled (demo mode)' });
      return;
    }
    const patch = dshSettings.readDshPatch();
    res.json({
      available: patch !== null,
      dshVersion: dshSettings.dshVersion(),
      nodeVersion: process.versions.node,
      home: process.env.DSH_HOME ?? null,
      provider: patch?.provider ?? null,
      model: patch?.model ?? null,
      models: patch?.models ?? [],
      baseURL: patch?.baseURL ?? null,
      apiKeyEnv: patch?.apiKeyEnv ?? null,
      hasKey:
        process.env.PIHUB_LLM_KEY !== undefined && process.env.PIHUB_LLM_KEY.length > 0,
      patchPath: patch?.patchPath ?? null,
    });
  });

  /* ---- dsh session history (auto-discovered in the sessions view) ---- */
  router.get('/api/dsh/sessions', async (_req, res) => {
    const listFn = options?.dshSessions;
    if (listFn === undefined) {
      res.status(503).json({ error: 'dsh unavailable (demo mode)' });
      return;
    }
    try {
      res.json({ sessions: await listFn() });
    } catch (error) {
      res.status(502).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.put('/api/dsh/settings', async (req, res) => {
    if (dshExec === null) {
      res.status(503).json({ error: 'dsh kernel disabled (demo mode)' });
      return;
    }
    const model = (req.body as { model?: unknown }).model;
    if (typeof model !== 'string' || model.trim().length === 0) {
      res.status(400).json({ error: 'model is required' });
      return;
    }
    const patch = dshSettings.readDshPatch();
    if (patch === null) {
      res.status(404).json({ error: 'gateway patch not found' });
      return;
    }
    if (!patch.models.includes(model)) {
      res.status(400).json({ error: `model not in gateway list: ${model}`, models: patch.models });
      return;
    }
    const result = await dshSettings.updateDshPatchModel(model);
    if (result === null) {
      res.status(500).json({ error: 'failed to update gateway patch' });
      return;
    }
    res.json({ success: true, model });
  });

  /* ---- external sessions (terminal pi/codex/dsh shared stream) ---- */
  router.get('/api/external/sessions', (_req, res) => {
    const watcher = options?.externalSessions;
    if (watcher === undefined) {
      res.json({ sessions: [] });
      return;
    }
    res.json({ sessions: watcher.list() });
  });

  /* ---- runtime capabilities (agent binaries/session homes/private space) ---- */
  router.get('/api/capabilities', (_req, res) => {
    res.json(probeCapabilities());
  });

  /* ---- agent management (panel-side startup/config) ---- */
  router.get('/api/agents', (_req, res) => {
    if (options?.agents === undefined) {
      res.json({ agents: [] });
      return;
    }
    res.json({ agents: options.agents.list() });
  });

  router.post('/api/agents/:kind/configure', (req, res) => {
    if (options?.agents === undefined) {
      res.status(503).json({ error: 'agent management unavailable' });
      return;
    }
    const rawKind = req.params['kind'];
    if (rawKind !== 'pi' && rawKind !== 'codex' && rawKind !== 'dsh') {
      res.status(400).json({ error: 'kind must be pi, codex or dsh' });
      return;
    }
    const kind: AgentKind = rawKind;
    const body = req.body as { binary?: unknown; enabled?: unknown };
    const patch: { binary?: string; enabled?: boolean } = {};
    if (body.binary !== undefined) {
      if (typeof body.binary !== 'string') {
        res.status(400).json({ error: 'binary must be a string' });
        return;
      }
      patch.binary = body.binary;
    }
    if (body.enabled !== undefined) {
      if (typeof body.enabled !== 'boolean') {
        res.status(400).json({ error: 'enabled must be a boolean' });
        return;
      }
      patch.enabled = body.enabled;
    }
    const result = options.agents.configure(kind, patch);
    if (!result.success) {
      res.status(502).json({ error: result.error ?? 'configure failed' });
      return;
    }
    res.json({ success: true, agents: options.agents.list() });
  });

  router.post('/api/agents/pi/restart', async (_req, res) => {
    if (options?.agents === undefined) {
      res.status(503).json({ error: 'agent management unavailable' });
      return;
    }
    const result = await options.agents.restartPi();
    if (!result.success) {
      res.status(502).json({ error: result.error ?? 'pi restart failed' });
      return;
    }
    res.json({ success: true });
  });

  router.post('/api/agents/:kind/install', async (req, res) => {
    if (options?.agents === undefined) {
      res.status(503).json({ error: 'agent management unavailable' });
      return;
    }
    const rawKind = req.params['kind'];
    if (rawKind !== 'pi' && rawKind !== 'codex' && rawKind !== 'dsh' && rawKind !== 'claude') {
      res.status(400).json({ error: 'kind must be pi, codex, dsh or claude' });
      return;
    }
    const kind: AgentKind = rawKind;
    const result = await options.agents.install(kind);
    if (!result.success) {
      res.status(400).json({ error: result.error ?? 'install not available' });
      return;
    }
    res.json({ success: true, status: options.agents.installStatus(kind) });
  });

  router.get('/api/agents/:kind/install', (req, res) => {
    if (options?.agents === undefined) {
      res.status(503).json({ error: 'agent management unavailable' });
      return;
    }
    const rawKind = req.params['kind'];
    if (rawKind !== 'pi' && rawKind !== 'codex' && rawKind !== 'dsh' && rawKind !== 'claude') {
      res.status(400).json({ error: 'kind must be pi, codex, dsh or claude' });
      return;
    }
    res.json({ status: options.agents.installStatus(rawKind) });
  });

  /* ---- dsh web integration (stage 3) ---- */
  router.get('/api/dsh/web/status', (_req, res) => {
    if (options?.dshWeb === undefined) {
      res.json({
        connected: false,
        state: 'disconnected',
        url: null,
        protocol: 'dsh-web-rpc-v1',
        describe: null,
        lastError: null,
      });
      return;
    }
    res.json(options.dshWeb.status());
  });

  router.post('/api/dsh/web/connect', async (req, res) => {
    if (options?.dshWeb === undefined) {
      res.status(503).json({ error: 'dsh web integration unavailable' });
      return;
    }
    const url = (req.body as { url?: unknown }).url;
    if (typeof url !== 'string' || url.trim().length === 0) {
      res.status(400).json({ error: 'url is required' });
      return;
    }
    let parsed: URL;
    try {
      parsed = new URL(url.trim());
    } catch {
      res.status(400).json({ error: 'invalid url' });
      return;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      res.status(400).json({ error: 'only http(s) urls are accepted' });
      return;
    }
    const result = await options.dshWeb.connect(parsed.toString().replace(/\/+$/, ''));
    if (!result.ok) {
      res.status(502).json({ error: result.error ?? 'dsh web unreachable' });
      return;
    }
    res.json({ success: true, status: options.dshWeb.status() });
  });

  router.post('/api/dsh/web/disconnect', (_req, res) => {
    if (options?.dshWeb === undefined) {
      res.status(503).json({ error: 'dsh web integration unavailable' });
      return;
    }
    options.dshWeb.disconnect();
    res.json({ success: true, status: options.dshWeb.status() });
  });

  router.get('/api/dsh/web/sessions', async (_req, res) => {
    if (options?.dshWeb === undefined) {
      res.status(503).json({ error: 'dsh web integration unavailable' });
      return;
    }
    const result = await options.dshWeb.listSessions();
    if (!result.ok) {
      res.status(502).json({ error: result.error ?? 'dsh web session.list failed' });
      return;
    }
    res.json({ sessions: result.value ?? [] });
  });

  router.get('/api/dsh/web/history', async (req, res) => {
    if (options?.dshWeb === undefined) {
      res.status(503).json({ error: 'dsh web integration unavailable' });
      return;
    }
    const sessionId = typeof req.query['sessionId'] === 'string' ? req.query['sessionId'] : '';
    if (sessionId.length === 0) {
      res.status(400).json({ error: 'sessionId is required' });
      return;
    }
    const result = await options.dshWeb.history(sessionId);
    if (!result.ok) {
      res.status(502).json({ error: result.error ?? 'dsh web session.history failed' });
      return;
    }
    res.json({ history: result.value ?? [] });
  });

  router.post('/api/dsh/web/prompt', async (req, res) => {
    if (options?.dshWeb === undefined) {
      res.status(503).json({ error: 'dsh web integration unavailable' });
      return;
    }
    const sessionId = (req.body as { sessionId?: unknown }).sessionId;
    const text = (req.body as { text?: unknown }).text;
    const mode = (req.body as { mode?: unknown }).mode ?? 'queue';
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      res.status(400).json({ error: 'sessionId is required' });
      return;
    }
    if (typeof text !== 'string' || text.trim().length === 0) {
      res.status(400).json({ error: 'text is required' });
      return;
    }
    if (mode !== 'queue' && mode !== 'steer') {
      res.status(400).json({ error: "mode must be 'queue' or 'steer'" });
      return;
    }
    const result = await options.dshWeb.prompt(sessionId, text.trim(), mode);
    if (!result.ok) {
      res.status(502).json({ error: result.error ?? 'dsh web session.prompt failed' });
      return;
    }
    res.json({ success: true, value: result.value ?? null });
  });

  router.post('/api/dsh/web/cancel', async (req, res) => {
    if (options?.dshWeb === undefined) {
      res.status(503).json({ error: 'dsh web integration unavailable' });
      return;
    }
    const sessionId = (req.body as { sessionId?: unknown }).sessionId;
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      res.status(400).json({ error: 'sessionId is required' });
      return;
    }
    const result = await options.dshWeb.cancel(sessionId);
    if (!result.ok) {
      res.status(502).json({ error: result.error ?? 'dsh web session.cancel failed' });
      return;
    }
    res.json({ success: true });
  });

  router.post('/api/dsh/web/session', async (req, res) => {
    if (options?.dshWeb === undefined) {
      res.status(503).json({ error: 'dsh web integration unavailable' });
      return;
    }
    const cwd = (req.body as { cwd?: unknown }).cwd;
    if (cwd !== undefined && (typeof cwd !== 'string' || cwd.trim().length === 0)) {
      res.status(400).json({ error: 'cwd must be a non-empty string when provided' });
      return;
    }
    const result = await options.dshWeb.createSession(
      typeof cwd === 'string' ? cwd.trim() : undefined,
    );
    if (!result.ok) {
      res.status(502).json({ error: result.error ?? 'dsh web session.create failed' });
      return;
    }
    res.json({ success: true, session: result.value ?? null });
  });

  router.get('/api/dsh/web/models', async (_req, res) => {
    if (options?.dshWeb === undefined) {
      res.status(503).json({ error: 'dsh web integration unavailable' });
      return;
    }
    const result = await options.dshWeb.models();
    if (!result.ok) {
      res.status(502).json({ error: result.error ?? 'dsh web llm.models failed' });
      return;
    }
    res.json({ models: result.value ?? [] });
  });

  router.get('/api/dsh/web/approvals', (_req, res) => {
    if (options?.dshWeb === undefined) {
      res.status(503).json({ error: 'dsh web integration unavailable' });
      return;
    }
    res.json({ approvals: options.dshWeb.approvals() });
  });

  router.post('/api/dsh/web/approve', async (req, res) => {
    if (options?.dshWeb === undefined) {
      res.status(503).json({ error: 'dsh web integration unavailable' });
      return;
    }
    const rpcId = (req.body as { rpcId?: unknown }).rpcId;
    const sessionId = (req.body as { sessionId?: unknown }).sessionId;
    const approvalId = (req.body as { approvalId?: unknown }).approvalId;
    const outcome = (req.body as { outcome?: unknown }).outcome;
    if (typeof rpcId !== 'string' || rpcId.length === 0) {
      res.status(400).json({ error: 'rpcId is required' });
      return;
    }
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      res.status(400).json({ error: 'sessionId is required' });
      return;
    }
    if (typeof approvalId !== 'string' || approvalId.length === 0) {
      res.status(400).json({ error: 'approvalId is required' });
      return;
    }
    if (outcome !== 'allowed-once' && outcome !== 'rejected') {
      res.status(400).json({ error: "outcome must be 'allowed-once' or 'rejected'" });
      return;
    }
    const result = await options.dshWeb.approve(rpcId, sessionId, approvalId, outcome);
    if (!result.ok) {
      res.status(502).json({ error: result.error ?? 'dsh web approval rejected' });
      return;
    }
    res.json({ success: true });
  });

  /* ---- claude exec adapter (headless per-prompt conversation) ---- */
  const claudeExec = options?.claudeExec ?? null;

  router.post('/api/claude/prompt', async (req, res) => {
    if (claudeExec === null) {
      res.status(503).json({ error: 'claude adapter disabled (demo mode)' });
      return;
    }
    const message = (req.body as { message?: unknown }).message;
    if (typeof message !== 'string' || message.trim().length === 0) {
      res.status(400).json({ error: 'message is required' });
      return;
    }
    let cwd: string | undefined;
    const rawCwd = (req.body as { cwd?: unknown }).cwd;
    if (typeof rawCwd === 'string' && rawCwd.trim().length > 0) {
      const target = path.resolve(rawCwd.trim());
      const statResult = await stat(target).catch(() => null);
      if (statResult === null || !statResult.isDirectory()) {
        res.status(400).json({ error: `directory not found: ${target}` });
        return;
      }
      cwd = target;
    }
    const response = await claudeExec.prompt(message.trim(), cwd);
    if (!response.success) {
      res.status(409).json({ error: response.error ?? 'claude rejected the prompt' });
      return;
    }
    res.json({ success: true, ...(response.data !== undefined ? { data: response.data } : {}) });
  });

  router.post('/api/claude/abort', async (_req, res) => {
    if (claudeExec === null) {
      res.status(503).json({ error: 'claude adapter disabled (demo mode)' });
      return;
    }
    await claudeExec.abort();
    res.json({ success: true });
  });

  router.get('/api/claude/state', async (_req, res) => {
    if (claudeExec === null) {
      res.status(503).json({ error: 'claude adapter disabled (demo mode)' });
      return;
    }
    const response = await claudeExec.state();
    res.json({ running: response.data?.isStreaming ?? false });
  });

  router.get('/api/claude/messages', async (_req, res) => {
    if (claudeExec === null) {
      res.status(503).json({ error: 'claude adapter disabled (demo mode)' });
      return;
    }
    res.json({ messages: await claudeExec.messages() });
  });

  router.get('/api/codex/sessions', async (_req, res) => {
    const fn = options?.adapters?.codexSessions;
    if (fn === undefined) {
      res.json({ sessions: [] });
      return;
    }
    try {
      res.json({ sessions: await fn() });
    } catch (error) {
      res.status(502).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });
  router.get('/api/codex/sessions/:id', async (req, res) => {
    const fn = options?.adapters?.codexSessionDetail;
    if (fn === undefined) {
      res.status(404).json({ error: 'codex history unavailable' });
      return;
    }
    const id = req.params['id'];
    if (typeof id !== 'string' || !/^[A-Za-z0-9-]{1,64}$/.test(id)) {
      res.status(400).json({ error: 'invalid session id' });
      return;
    }
    try {
      const detail = await fn(id);
      if (detail === null) {
        res.status(404).json({ error: 'codex session not found' });
        return;
      }
      res.json(detail);
    } catch (error) {
      res.status(502).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  /* ---- ADAPTER2: atomcode + zcode read-only history ---- */
  router.get('/api/atomcode/sessions', async (_req, res) => {
    const fn = options?.adapters?.atomcodeSession;
    if (fn === undefined) {
      res.json({ session: null });
      return;
    }
    try {
      res.json({ session: await fn() });
    } catch (error) {
      res.status(502).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });
  router.get('/api/zcode/sessions', async (_req, res) => {
    const fn = options?.adapters?.zcodeSessions;
    if (fn === undefined) {
      res.json({ sessions: [] });
      return;
    }
    try {
      res.json({ sessions: await fn() });
    } catch (error) {
      res.status(502).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });
  router.get('/api/zcode/sessions/:id', async (req, res) => {
    const fn = options?.adapters?.zcodeSessionDetail;
    if (fn === undefined) {
      res.status(404).json({ error: 'zcode history unavailable' });
      return;
    }
    const id = req.params['id'];
    if (typeof id !== 'string' || !/^[A-Za-z0-9()._-]{1,128}$/.test(id)) {
      res.status(400).json({ error: 'invalid session id' });
      return;
    }
    try {
      const detail = await fn(id);
      if (detail === null) {
        res.status(404).json({ error: 'zcode session not found' });
        return;
      }
      res.json(detail);
    } catch (error) {
      res.status(502).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  /* ---- official model catalog (P1-15 C) ----
   * pi.dev serves per-provider model catalogs at
   * GET https://pi.dev/api/models/providers/<id> (the same public endpoint
   * pi itself refreshes into models-store.json every 4h). Custom channel
   * keys (e.g. volcengine-ark) return 404 — surfaced honestly. Read-only;
   * never touches ~/.pi or auth.json. Small TTL cache to stay polite. */
  const catalogCache = new Map<string, { at: number; status: number; body: unknown }>();
  const CATALOG_TTL_MS = 10 * 60 * 1000;
  router.get('/api/models/catalog/:provider', async (req, res) => {
    const provider = req.params['provider'];
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(provider)) {
      res.status(400).json({ error: 'invalid provider id' });
      return;
    }
    const cached = catalogCache.get(provider);
    if (cached !== undefined && Date.now() - cached.at < CATALOG_TTL_MS) {
      res.status(cached.status).json(cached.body);
      return;
    }
    try {
      // pi.dev has intermittent connectivity from some networks — one retry
      // before surfacing the honest 502.
      let response: Response | null = null;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          response = await fetch(
            `https://pi.dev/api/models/providers/${encodeURIComponent(provider)}`,
            {
              headers: { accept: 'application/json', 'User-Agent': 'pihub/1.0' },
              signal: AbortSignal.timeout(12000),
            },
          );
          break;
        } catch {
          if (attempt === 0) {
            await new Promise((resolve) => setTimeout(resolve, 1000));
          } else {
            throw new Error('fetch failed after retry');
          }
        }
      }
      if (response === null) {
        throw new Error('fetch failed');
      }
      const body: unknown = await response.json().catch(() => null);
      catalogCache.set(provider, { at: Date.now(), status: response.status, body });
      res.status(response.status).json(body);
    } catch (error) {
      res
        .status(502)
        .json({ error: `catalog fetch failed: ${error instanceof Error ? error.message : String(error)}` });
    }
  });

  router.post('/api/rpc/prompt', async (req, res) => {
    if (writeDenied(res) || remoteWriteDenied(req, res, 'prompt')) {
      return;
    }
    const body = promptBodySchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: 'invalid prompt body' });
      return;
    }
    await withBridge(res, () =>
      bridge.send({
        type: 'prompt',
        message: body.data.message,
        ...(body.data.streamingBehavior !== undefined
          ? { streamingBehavior: body.data.streamingBehavior }
          : {}),
        ...(body.data.images !== undefined ? { images: body.data.images } : {}),
      }),
    );
  });

  router.post('/api/rpc/steer', async (req, res) => {
    if (writeDenied(res) || remoteWriteDenied(req, res, 'prompt')) {
      return;
    }
    const body = steerBodySchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: 'invalid steer body' });
      return;
    }
    await withBridge(res, () => bridge.send({ type: 'steer', message: body.data.message }));
  });

  router.post('/api/rpc/abort', async (_req, res) => {
    if (writeDenied(res)) {
      return;
    }
    await withBridge(res, () => bridge.send({ type: 'abort' }));
  });

  router.post('/api/rpc/model', async (req, res) => {
    if (writeDenied(res)) {
      return;
    }
    const body = modelBodySchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: 'invalid model body' });
      return;
    }
    await withBridge(res, () =>
      bridge.send({
        type: 'set_model',
        provider: body.data.provider,
        modelId: body.data.modelId,
      }),
    );
  });

  router.post('/api/rpc/thinking', async (req, res) => {
    if (writeDenied(res)) {
      return;
    }
    const body = thinkingBodySchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: 'invalid thinking level' });
      return;
    }
    await withBridge(res, () =>
      bridge.send({ type: 'set_thinking_level', level: body.data.level }),
    );
  });

  router.get('/api/rpc/state', async (_req, res) => {
    if (mode === 'demo') {
      // kMode: demo never spawns real pi; synthesize the state the frontend
      // sessionWatch expects, driven by the demo machine phase.
      const phase = demoMachine?.getPhase() ?? 'idle';
      res.json({
        model: { provider: 'demo-provider', id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
        sessionFile: DEMO_RUNNING_ID,
        isAgentRunning: phase === 'thinking' || phase === 'tool' || phase === 'streaming',
        isCompacting: false,
      });
      return;
    }
    await withBridge(res, () => bridge.send({ type: 'get_state' }));
  });

  router.get('/api/rpc/messages', async (_req, res) => {
    if (mode === 'demo') {
      // kMode: demo never spawns real pi; serve the running mock session's
      // message stream so the chat view renders the showcase conversation.
      const detail = await sessions.get(DEMO_RUNNING_ID);
      const messages =
        detail?.entries
          .filter((entry) => entry.type === 'message')
          .map((entry) => entry.message) ?? [];
      res.json({ messages });
      return;
    }
    await withBridge(res, () => bridge.send({ type: 'get_messages' }));
  });

  // Entry tree of the current RPC session (used to resolve branch points).
  router.get('/api/rpc/entries', async (_req, res) => {
    await withBridge(res, () => bridge.send({ type: 'get_entries' }));
  });

  // Session tree DAG of the current RPC session (P1-05 session-tree viz).
  // Pass-through of the official pi `get_tree` command; the frontend renders
  // the DAG (branch timeline / node labels) from the returned shape.
  router.get('/api/rpc/tree', async (_req, res) => {
    if (mode === 'demo') {
      // kMode: demo has no live pi; serve the mock session's parsed tree so
      // the tree view keeps the same API shape.
      const detail = await sessions.get(DEMO_RUNNING_ID);
      if (detail === null) {
        res.status(404).json({ error: 'no demo session' });
        return;
      }
      res.json({ tree: detail.tree, leafId: detail.leafId });
      return;
    }
    await withBridge(res, () => bridge.send({ type: 'get_tree' }));
  });

  router.post('/api/rpc/switch_session', async (req, res) => {
    if (writeDenied(res)) {
      return;
    }
    const body = switchSessionBodySchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: 'invalid session path' });
      return;
    }
    try {
      const response = await bridge.send({
        type: 'switch_session',
        sessionPath: body.data.sessionPath,
      });
      // P1-03: the file preview follows the ACTIVE session's cwd — resolve
      // it from the session store (best-effort, keeps the previous root on
      // failure).
      void resolvePreviewRoot(body.data.sessionPath);
      res.json(response);
    } catch (error) {
      res.status(502).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post('/api/rpc/new_session', async (req, res) => {
    if (writeDenied(res)) {
      return;
    }
    // Run targeting: an optional chosen working directory re-targets the pi
    // bridge (spawn cwd) before the new session is created; the agent choice
    // is echoed back for the SPA's session routing.
    const body = (req.body ?? {}) as { cwd?: unknown; agent?: unknown; serviceTarget?: unknown };
    const rawAgent = body.agent;
    const agent = rawAgent === 'codex' || rawAgent === 'dsh' || rawAgent === 'claude' ? rawAgent : 'pi';
    const serviceTarget =
      body.serviceTarget === 'local-service' || body.serviceTarget === 'remote-pihub' || body.serviceTarget === 'nearby-pihub'
        ? body.serviceTarget
        : 'builtin-pihub';
    try {
      const surface = options?.runtimeSurface?.();
      const target = surface?.services.find((entry) => entry.id === serviceTarget);
      if (target !== undefined && !target.canCreateSession) {
        res.status(409).json({
          error: target.reason ?? `service target unavailable: ${serviceTarget}`,
          serviceTarget,
          sessionCreation: target.sessionCreation,
        });
        return;
      }
      const engine = surface?.engines.find((entry) => entry.engine === (agent === 'dsh' ? 'dsh' : 'pi'));
      if (engine !== undefined && !engine.canCreateSession) {
        res.status(503).json({ error: engine.reason ?? `engine unavailable: ${agent}`, engine: engine.engine });
        return;
      }
      // Non-pi agents (codex/dsh/claude) do not own the pi RPC bridge — a
      // new session for them must NOT touch it (on devices without pi this
      // used to hang every new session with an RPC timeout).
      if (agent !== 'pi') {
        res.json({
          success: true,
          agent,
          serviceTarget,
          cwd: typeof body.cwd === 'string' ? body.cwd : null,
          note: `session created for ${agent} (no pi bridge involved)`,
        });
        return;
      }
      if (typeof body.cwd === 'string' && body.cwd.trim().length > 0) {
        const target = path.resolve(body.cwd.trim());
        const statResult = await stat(target).catch(() => null);
        if (statResult === null || !statResult.isDirectory()) {
          res.status(400).json({ error: `directory not found: ${target}` });
          return;
        }
        if (bridge.getCwd() !== target) {
          bridge.restart(target);
        }
      }
      // A restart can leave a spawned child before its RPC loop has loaded.
      // Always await a real get_state round-trip before creating the session;
      // this also covers a same-cwd restart from the Pi Agent settings page.
      await bridge.waitReady(10_000);
      const response = await bridge.send({ type: 'new_session' });
      res.json({
        ...response,
        ...(typeof body.cwd === 'string' && body.cwd.trim().length > 0
          ? { cwd: path.resolve(body.cwd.trim()) }
          : {}),
        agent,
        serviceTarget,
      });
    } catch (error) {
      res.status(502).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post('/api/rpc/fork', async (req, res) => {
    if (writeDenied(res)) {
      return;
    }
    const body = forkBodySchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: 'invalid entry id' });
      return;
    }
    try {
      const response = await bridge.send({ type: 'fork', entryId: body.data.entryId });
      res.json(response);
    } catch (error) {
      res.status(502).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post('/api/rpc/clone', async (_req, res) => {
    if (writeDenied(res)) {
      return;
    }
    try {
      const response = await bridge.send({ type: 'clone' });
      res.json(response);
    } catch (error) {
      res.status(502).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post('/api/rpc/steering-mode', async (req, res) => {
    if (writeDenied(res)) {
      return;
    }
    const body = req.body as Record<string, unknown> | null;
    const mode = typeof body === 'object' && body !== null ? body['mode'] : undefined;
    if (typeof mode !== 'string' || mode.length === 0) {
      res.status(400).json({ error: 'invalid steering mode' });
      return;
    }
    try {
      const response = await bridge.send({ type: 'set_steering_mode', mode });
      res.json(response);
    } catch (error) {
      res.status(502).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post('/api/rpc/follow-up-mode', async (req, res) => {
    if (writeDenied(res)) {
      return;
    }
    const body = req.body as Record<string, unknown> | null;
    const mode = typeof body === 'object' && body !== null ? body['mode'] : undefined;
    if (typeof mode !== 'string' || mode.length === 0) {
      res.status(400).json({ error: 'invalid follow-up mode' });
      return;
    }
    try {
      const response = await bridge.send({ type: 'set_follow_up_mode', mode });
      res.json(response);
    } catch (error) {
      res.status(502).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post('/api/rpc/cycle-model', async (_req, res) => {
    if (writeDenied(res)) {
      return;
    }
    try {
      const response = await bridge.send({ type: 'cycle_model' });
      res.json(response);
    } catch (error) {
      res.status(502).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post('/api/rpc/rename', async (req, res) => {
    if (writeDenied(res)) {
      return;
    }
    const body = renameBodySchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: 'invalid session name' });
      return;
    }
    try {
      const response = await bridge.send({
        type: 'set_session_name',
        name: body.data.name,
      });
      res.json(response);
    } catch (error) {
      res.status(502).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.get('/api/rpc/commands', async (_req, res) => {
    await withBridge(res, () => bridge.send({ type: 'get_commands' }));
  });

  router.post('/api/rpc/bash', async (req, res) => {
    if (writeDenied(res) || remoteWriteDenied(req, res, 'shell')) {
      return;
    }
    const body = bashBodySchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: 'invalid bash command' });
      return;
    }
    try {
      const response = await bridge.send({ type: 'bash', command: body.data.command });
      res.json(response);
    } catch (error) {
      res.status(502).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post('/api/rpc/abort-bash', async (_req, res) => {
    if (writeDenied(res)) {
      return;
    }
    try {
      const response = await bridge.send({ type: 'abort_bash' });
      res.json(response);
    } catch (error) {
      res.status(502).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post('/api/rpc/compact', async (_req, res) => {
    if (writeDenied(res)) {
      return;
    }
    try {
      const response = await bridge.send({ type: 'compact' });
      res.json(response);
    } catch (error) {
      res.status(502).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post('/api/rpc/auto-compaction', async (req, res) => {
    if (writeDenied(res)) {
      return;
    }
    const body = autoCompactionBodySchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: 'invalid auto-compaction body' });
      return;
    }
    try {
      const response = await bridge.send({
        type: 'set_auto_compaction',
        enabled: body.data.enabled,
      });
      res.json(response);
    } catch (error) {
      res.status(502).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  /* ---- P1-02 S2: auto-retry toggle (pi set_auto_retry {enabled}). ---- */
  router.post('/api/rpc/auto-retry', async (req, res) => {
    if (writeDenied(res)) {
      return;
    }
    const body = autoCompactionBodySchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: 'invalid auto-retry body' });
      return;
    }
    try {
      const response = await bridge.send({
        type: 'set_auto_retry',
        enabled: body.data.enabled,
      });
      res.json(response);
    } catch (error) {
      res.status(502).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.get('/api/rpc/session-stats', async (_req, res) => {
    await withBridge(res, () => bridge.send({ type: 'get_session_stats' }));
  });

  /* ---- P1-03: read-only file preview within the ACTIVE session's cwd ----
   * The root follows the session the user switched to (resolvePreviewRoot),
   * falling back to the panel workspace. Paths are normalized and must stay
   * inside the root subtree; traversal or oversized files fail honestly. */
  let previewRoot: string | undefined = options?.allowedRoot;
  const resolvePreviewRoot = async (sessionPath: string): Promise<void> => {
    try {
      const all = await sessions.list();
      const match = all.find((session) => session.fileName === sessionPath);
      if (match !== undefined && match.cwd.length > 0) {
        previewRoot = match.cwd;
      }
    } catch {
      // keep the previous root — preview stays conservative
    }
  };
  const resolveWorkspaceRoot = async (sessionPath: string | undefined): Promise<string | null> => {
    if (sessionPath !== undefined && sessionPath.length > 0) {
      // A freshly-created Pi session may not have written its JSONL header
      // yet (the file is often created only after the first prompt).  The
      // RPC bridge still knows the exact active session file from
      // `get_state`; use its current cwd for that one exact identity so
      // Files/Changes/preview work during the pre-prompt window.  Do not
      // apply this fallback to arbitrary/old session paths.
      if (bridge.getSessionId() === sessionPath) {
        const activeCwd = bridge.getCwd();
        if (activeCwd.length > 0) {
          return activeCwd;
        }
      }
      try {
        const all = await sessions.list();
        const match = all.find((session) => session.fileName === sessionPath);
        if (match !== undefined && match.cwd.length > 0) {
          return match.cwd;
        }
      } catch {
        // fall through to the default workspace
      }
    }
    return options?.allowedRoot ?? previewRoot ?? null;
  };
  const MAX_PREVIEW_BYTES = 512 * 1024;
  router.get('/api/file/preview', async (req, res) => {
    const sessionParam = typeof req.query['session'] === 'string' ? req.query['session'] : undefined;
    const root = await resolveWorkspaceRoot(sessionParam);
    if (root === null || root.length === 0) {
      res.status(503).json({ error: 'file preview unavailable' });
      return;
    }
    const rawPath = typeof req.query['path'] === 'string' ? req.query['path'] : '';
    if (rawPath.length === 0 || rawPath.length > 1024) {
      res.status(400).json({ error: 'invalid path' });
      return;
    }
    const rootResolved = path.resolve(root);
    const resolved = path.resolve(rootResolved, rawPath);
    if (resolved !== rootResolved && !resolved.startsWith(`${rootResolved}${path.sep}`)) {
      res.status(400).json({ error: 'path outside workspace' });
      return;
    }
    try {
      // SPRINT-2 A2: string-prefix containment is not enough — stat/readFile
      // follow symlinks, so a symlink inside the workspace pointing outside
      // would escape. Re-verify the REAL path against the real root.
      const [realRoot, realTarget] = await Promise.all([
        realpath(rootResolved),
        realpath(resolved),
      ]);
      if (realTarget !== realRoot && !realTarget.startsWith(`${realRoot}${path.sep}`)) {
        res.status(400).json({ error: 'path outside workspace' });
        return;
      }
      const info = await stat(realTarget);
      if (!info.isFile()) {
        res.status(400).json({ error: 'not a file' });
        return;
      }
      if (info.size > MAX_PREVIEW_BYTES) {
        res.status(413).json({ error: 'file too large for preview', size: info.size });
        return;
      }
      const content = await readFile(realTarget, 'utf8');
      res.json({ path: realTarget, size: info.size, content });
    } catch (error) {
      res.status(404).json({ error: `cannot read file: ${error instanceof Error ? error.message : String(error)}` });
    }
  });

  // Extension UI protocol (P1-01): pending dialog requests + answering.
  router.get('/api/rpc/ui-requests', (_req, res) => {
    res.json({ requests: bridge.getPendingUiRequests() });
  });

  /* ---- P1-08b: read-only workspace file listing (right workbench 文件) ----
   * Same containment rules as the preview: the root is the given session's
   * cwd (falling back to the tracked preview root), paths must stay inside
   * the real root subtree, hidden dirs are skipped. Returns the entries of
   * one directory plus the session's recent file operations. */
  const IGNORED_LISTING = new Set(['.git', 'node_modules', '.DS_Store']);
  const MAX_LISTING_ENTRIES = 500;

  /* ---- session/task targeting: directory browser (token-gated) ----
   * Lists the subdirectories of any absolute path so a new session or run
   * can choose its working folder. The SPA fetches with the control token
   * (SENSITIVE_READ_EXACT) and walks up/down one level at a time. */
  router.get('/api/dirs', async (req, res) => {
    const rawPath = typeof req.query['path'] === 'string' ? req.query['path'] : '';
    // Some managed Node hosts report a home the process cannot read; walk a
    // fallback chain of reachable roots so
    // the folder browser always opens on a readable path.
    let target = rawPath.length === 0 ? os.homedir() : path.resolve(rawPath);
    if (rawPath.length === 0) {
      const candidates = [os.homedir(), process.cwd(), process.env.PIHUB_HOME].filter(
        (candidate): candidate is string =>
          typeof candidate === 'string' && candidate.length > 0 && path.isAbsolute(candidate),
      );
      for (const candidate of candidates) {
        const info = await stat(candidate).catch(() => null);
        const readable =
          info !== null && info.isDirectory() && (await readdir(candidate).catch(() => null)) !== null;
        if (readable) {
          target = candidate;
          break;
        }
      }
    }
    if (!path.isAbsolute(target)) {
      res.status(400).json({ error: 'path must be absolute' });
      return;
    }
    const statResult = await stat(target).catch(() => null);
    if (statResult === null || !statResult.isDirectory()) {
      res.status(404).json({ error: `directory not found: ${target}` });
      return;
    }
    let entries: string[] = [];
    try {
      const dirents = await readdir(target, { withFileTypes: true });
      entries = dirents
        .filter((entry) => entry.isDirectory() && !IGNORED_LISTING.has(entry.name) && !entry.name.startsWith('.'))
        .map((entry) => entry.name)
        .sort((a, b) => a.localeCompare(b));
    } catch {
      res.status(403).json({ error: `cannot read directory: ${target}` });
      return;
    }
    res.json({ path: target, dirs: entries });
  });

  router.get('/api/files', async (req, res) => {
    const sessionParam = typeof req.query['session'] === 'string' ? req.query['session'] : undefined;
    const rawPath = typeof req.query['path'] === 'string' ? req.query['path'] : '';
    if (rawPath.length > 1024) {
      res.status(400).json({ error: 'invalid path' });
      return;
    }
    // Session cwd when named; the persistent default workspace otherwise.
    const root = await resolveWorkspaceRoot(sessionParam);
    if (root === null || root.length === 0) {
      res.status(503).json({ error: 'file listing unavailable' });
      return;
    }
    const rootResolved = path.resolve(root);
    const resolved = path.resolve(rootResolved, rawPath);
    if (resolved !== rootResolved && !resolved.startsWith(`${rootResolved}${path.sep}`)) {
      res.status(400).json({ error: 'path outside workspace' });
      return;
    }
    try {
      const [realRoot, realTarget] = await Promise.all([realpath(rootResolved), realpath(resolved)]);
      if (realTarget !== realRoot && !realTarget.startsWith(`${realRoot}${path.sep}`)) {
        res.status(400).json({ error: 'path outside workspace' });
        return;
      }
      const info = await stat(realTarget);
      if (!info.isDirectory()) {
        res.status(400).json({ error: 'not a directory' });
        return;
      }
      const dirents = await readdir(realTarget, { withFileTypes: true });
      const entries: Array<{
        name: string;
        path: string;
        kind: 'dir' | 'file' | 'other';
        size?: number;
        mtime?: number;
      }> = [];
      for (const dirent of dirents) {
        if (IGNORED_LISTING.has(dirent.name) || entries.length >= MAX_LISTING_ENTRIES) {
          continue;
        }
        const entryPath = rawPath.length === 0 ? dirent.name : `${rawPath}/${dirent.name}`;
        if (dirent.isDirectory()) {
          entries.push({ name: dirent.name, path: entryPath, kind: 'dir' });
        } else if (dirent.isFile()) {
          let size: number | undefined;
          let mtime: number | undefined;
          try {
            const st = await stat(path.join(realTarget, dirent.name));
            size = st.size;
            mtime = st.mtimeMs;
          } catch {
            // unreadable entry — list without stats
          }
          entries.push({
            name: dirent.name,
            path: entryPath,
            kind: 'file',
            ...(size !== undefined ? { size } : {}),
            ...(mtime !== undefined ? { mtime } : {}),
          });
        } else {
          // symlink or other — listing only; opening re-validates realpath
          entries.push({ name: dirent.name, path: entryPath, kind: 'other' });
        }
      }
      entries.sort((a, b) =>
        a.kind === 'dir' && b.kind !== 'dir'
          ? -1
          : a.kind !== 'dir' && b.kind === 'dir'
            ? 1
            : a.name.localeCompare(b.name),
      );
      const recent =
        sessionParam !== undefined && sessionParam.length > 0
          ? recentFileActions(await parseSessionFile(sessionParam).catch(() => null))
          : [];
      res.json({ root: realTarget, entries, recent });
    } catch (error) {
      res.status(404).json({ error: `cannot list directory: ${error instanceof Error ? error.message : String(error)}` });
    }
  });

  /* ---- P1-08b: read-only git worktree inspection (right workbench 变更) ----
   * `git status --porcelain=v1 -z` + `git diff` only — no write commands, no
   * shell, paths resolved inside the session cwd. */
  const resolveGitRoot = async (sessionParam: string | undefined): Promise<string | null> => {
    return resolveWorkspaceRoot(sessionParam);
  };

  router.get('/api/git/status', async (req, res) => {
    const sessionParam = typeof req.query['session'] === 'string' ? req.query['session'] : undefined;
    const root = await resolveGitRoot(sessionParam);
    if (root === null || root.length === 0) {
      res.status(503).json({ error: 'git status unavailable' });
      return;
    }
    try {
      const realRoot = await realpath(path.resolve(root));
      try {
        const changes = await gitStatus(realRoot);
        if (changes !== null) {
          res.json({ root: realRoot, repo: true, source: 'git', changes });
          return;
        }
      } catch (error) {
        if (!isGitUnavailableError(error)) {
          throw error;
        }
      }
      if (options?.workspaceChanges !== undefined) {
        const changes = await options.workspaceChanges.status(realRoot);
        res.json({ root: realRoot, repo: false, source: 'snapshot', changes });
        return;
      }
      res.json({ root: realRoot, repo: false, source: 'none', changes: [] });
    } catch (error) {
      res.status(502).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.get('/api/git/diff', async (req, res) => {
    const sessionParam = typeof req.query['session'] === 'string' ? req.query['session'] : undefined;
    const rawPath = typeof req.query['path'] === 'string' ? req.query['path'] : '';
    const staged = req.query['staged'] === '1' || req.query['staged'] === 'true';
    if (rawPath.length === 0 || rawPath.length > 1024) {
      res.status(400).json({ error: 'invalid path' });
      return;
    }
    const root = await resolveGitRoot(sessionParam);
    if (root === null || root.length === 0) {
      res.status(503).json({ error: 'git diff unavailable' });
      return;
    }
    const rootResolved = path.resolve(root);
    const resolved = path.resolve(rootResolved, rawPath);
    // Lexical containment against the REAL root: git paths may point at
    // deleted files, so realpath of the target is not required.
    if (resolved !== rootResolved && !resolved.startsWith(`${rootResolved}${path.sep}`)) {
      res.status(400).json({ error: 'path outside workspace' });
      return;
    }
    try {
      const realRoot = await realpath(rootResolved);
      try {
        const diff = await gitDiff(realRoot, rawPath, staged);
        if (diff !== null) {
          res.json({ source: 'git', diff });
          return;
        }
      } catch (error) {
        if (!isGitUnavailableError(error)) {
          throw error;
        }
      }
      if (options?.workspaceChanges !== undefined) {
        res.json({ source: 'snapshot', diff: await options.workspaceChanges.diff(realRoot, rawPath) });
        return;
      }
      res.json({ source: 'none', diff: '' });
    } catch (error) {
      res.status(502).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post('/api/rpc/ui-respond', (req, res) => {
    const body = uiRespondBodySchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: 'invalid ui-respond body' });
      return;
    }
    const ok = bridge.sendUiResponse(body.data);
    res.json({ success: ok });
  });

  router.post('/api/rpc/export-html', async (_req, res) => {
    if (writeDenied(res)) {
      return;
    }
    try {
      const response = await bridge.send({ type: 'export_html' });
      res.json(response);
    } catch (error) {
      res.status(502).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post('/api/settings/model', async (req, res) => {
    if (writeDenied(res)) {
      return;
    }
    const body = saveModelBodySchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: 'invalid model body' });
      return;
    }
    try {
      const settingsPath = path.join(AGENT_DIR, 'settings.json');
      const raw = await readJson(settingsPath);
      const current =
        typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
      const next = {
        ...current,
        defaultProvider: body.data.provider,
        defaultModel: body.data.modelId,
      };
      await writeFile(settingsPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
      res.json({ success: true, saved: { provider: body.data.provider, modelId: body.data.modelId } });
    } catch (error) {
      res.status(502).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.get('/api/models-config', async (_req, res) => {
    const raw = await readJson(path.join(AGENT_DIR, 'models.json'));
    res.json(raw === undefined ? { providers: {} } : raw);
  });

  router.post('/api/models-config', async (req, res) => {
    if (remoteWriteDenied(req, res, 'prompt')) {
      return;
    }
    if (mode === 'demo') {
      // kMode write guard: demo never mutates ~/.pi.
      res.status(503).json({ error: 'demo mode is read-only' });
      return;
    }
    const raw: unknown = req.body;
    if (typeof raw !== 'object' || raw === null) {
      res.status(400).json({ error: 'invalid models config' });
      return;
    }
    const providers = (raw as Record<string, unknown>)['providers'];
    if (typeof providers !== 'object' || providers === null) {
      res.status(400).json({ error: 'models config must contain providers object' });
      return;
    }
    try {
      const configPath = path.join(AGENT_DIR, 'models.json');
      await writeFile(configPath, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
      const reload = options?.reloadModels?.() ?? 'reloaded';
      res.json({ success: true, reload });
    } catch (error) {
      res.status(502).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  /* ---- per-channel model fetch (P1-17 C) ----
   * Query the channel's OWN model-list endpoint (`{baseUrl}/models`, shaped
   * per api style) using the panel-configured key — the same surface pi
   * itself talks to. Only the user-configured baseUrl/apiKey leave this
   * machine; errors surface honestly. */
  const fetchChannelModelsBodySchema = z.object({
    baseUrl: z.string().min(1).max(512),
    apiKey: z.string().min(1).max(4096),
    api: z.string().min(1).max(64),
  });
  router.post('/api/models/fetch', async (req, res) => {
    if (mode === 'demo') {
      res.status(503).json({ error: 'demo mode is read-only' });
      return;
    }
    const body = fetchChannelModelsBodySchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: 'invalid fetch body' });
      return;
    }
    const { baseUrl, apiKey, api } = body.data;
    const root = baseUrl.replace(/\/+$/u, '');
    let url: string;
    const headers: Record<string, string> = { accept: 'application/json' };
    if (api === 'anthropic') {
      url = `${root}/v1/models`;
      headers['x-api-key'] = apiKey;
      headers['anthropic-version'] = '2023-06-01';
    } else if (api === 'google-generative') {
      url = `${root}/models`;
      headers['x-goog-api-key'] = apiKey;
    } else {
      url = `${root}/models`;
      headers['authorization'] = `Bearer ${apiKey}`;
    }
    try {
      // P2-2: never send the channel API key to a non-public host.
      await assertPublicUrl(url);
      const response = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
      if (!response.ok) {
        res.status(502).json({ error: `provider returned HTTP ${String(response.status)}` });
        return;
      }
      const data: unknown = await response.json().catch(() => null);
      res.json({ models: normalizeChannelModels(data) });
    } catch (error) {
      res
        .status(502)
        .json({ error: `model fetch failed: ${error instanceof Error ? error.message : String(error)}` });
    }
  });

  router.get('/api/events', (req, res) => {
    hub.addClient(req, res);
    req.on('close', () => {
      // Client disconnect is handled inside the hub via res 'close'.
    });
  });

  /* ---- pipelines (P1-02-C, PiHub-exclusive orchestration) ---- */

  const pipelineStore = options?.pipelines?.store;
  const pipelineEngine = options?.pipelines?.engine ?? null;

  router.get('/api/pipelines', (_req, res) => {
    if (pipelineStore === undefined) {
      res.status(503).json({ error: 'pipelines unavailable' });
      return;
    }
    res.json({ pipelines: pipelineStore.list() });
  });

  router.post('/api/pipelines', (req, res) => {
    if (pipelineStore === undefined) {
      res.status(503).json({ error: 'pipelines unavailable' });
      return;
    }
    if (writeDenied(res)) {
      return;
    }
    const body = pipelineUpsertBodySchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: 'invalid pipeline definition' });
      return;
    }
    try {
      const saved = pipelineStore.save(body.data.pipeline);
      res.json({ pipeline: saved });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.delete('/api/pipelines/:id', (req, res) => {
    if (pipelineStore === undefined) {
      res.status(503).json({ error: 'pipelines unavailable' });
      return;
    }
    if (writeDenied(res)) {
      return;
    }
    res.json({ success: pipelineStore.remove(req.params.id) });
  });

  router.get('/api/pipelines/runs', (_req, res) => {
    if (pipelineEngine === null) {
      res.json({ runs: [] });
      return;
    }
    res.json({ runs: pipelineEngine.listRuns() });
  });

  router.get('/api/pipelines/:id/runs', (req, res) => {
    if (pipelineStore === undefined) {
      res.status(503).json({ error: 'pipelines unavailable' });
      return;
    }
    // v1b: serve typed receipts instead of the write-only aggregate history.
    res.json({ runs: pipelineStore.listRunReceipts(req.params.id) });
  });

  router.post('/api/pipelines/run', async (req, res) => {
    if (pipelineStore === undefined || pipelineEngine === null) {
      res.status(503).json({ error: 'pipelines unavailable' });
      return;
    }
    if (writeDenied(res)) {
      return;
    }
    const body = pipelineRunBodySchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: 'invalid run body' });
      return;
    }
    const pipeline = pipelineStore.get(body.data.pipelineId);
    if (pipeline === undefined) {
      res.status(404).json({ error: 'pipeline not found' });
      return;
    }
    // Best-effort session context for {{sessionName}}/{{cwd}} template vars.
    let context: { sessionName?: string; cwd?: string } = {};
    try {
      const state = await bridge.send({ type: 'get_state' });
      const data = state.data as Record<string, unknown> | null | undefined;
      if (typeof data === 'object' && data !== null) {
        const name = data['name'];
        const cwd = data['cwd'];
        if (typeof name === 'string') {
          context = { ...context, sessionName: name };
        }
        if (typeof cwd === 'string') {
          context = { ...context, cwd };
        }
      }
    } catch {
      // session context unavailable; empty vars stay untouched in templates
    }
    let run: PipelineRunRecord;
    try {
      // Run targeting: optional chosen folder + agent (validated below).
      let targeting: { cwd?: string; agent?: 'pi' | 'codex' } | undefined;
      if (typeof body.data.cwd === 'string' && body.data.cwd.trim().length > 0) {
        const target = path.resolve(body.data.cwd.trim());
        const statResult = await stat(target).catch(() => null);
        if (statResult === null || !statResult.isDirectory()) {
          res.status(400).json({ error: `directory not found: ${target}` });
          return;
        }
        targeting = { ...targeting, cwd: target };
      }
      if (body.data.agent !== undefined) {
        targeting = { ...targeting, agent: body.data.agent };
      }
      run = pipelineEngine.start(pipeline, body.data.input ?? '', context, targeting);
    } catch {
      // v1a serialization: the engine drives one pi session and refuses a
      // second concurrent run.
      res.status(409).json({ error: 'another pipeline run is active' });
      return;
    }
    res.json({ run });
  });

  router.post('/api/pipelines/runs/:id/abort', (req, res) => {
    if (pipelineEngine === null) {
      res.status(503).json({ error: 'pipelines unavailable' });
      return;
    }
    if (writeDenied(res)) {
      return;
    }
    res.json({ success: pipelineEngine.abort(req.params.id) });
  });

  router.post('/api/pipelines/runs/:id/approve', (req, res) => {
    if (pipelineEngine === null) {
      res.status(503).json({ error: 'pipelines unavailable' });
      return;
    }
    if (writeDenied(res)) {
      return;
    }
    const body = pipelineApproveBodySchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: 'invalid approve body' });
      return;
    }
    res.json({ success: pipelineEngine.approve(req.params.id, body.data.approve) });
  });

  /* ---- skill → pipeline conversion (P1-10 A; HaomoKit generalized
   * capability). Hard = algorithm, zero tokens. Soft = agent-assisted,
   * token cost — the frontend must confirm with the operator first. ---- */

  const resolveSkillCommand = async (commandName: string): Promise<PiCommand | null> => {
    try {
      const response = await bridge.send({ type: 'get_commands' });
      const data = response.data as { commands?: PiCommand[] } | null | undefined;
      const commands = Array.isArray(data?.commands) ? data.commands : [];
      return commands.find((c) => c.source === 'skill' && c.name === commandName) ?? null;
    } catch {
      return null;
    }
  };

  router.post('/api/pipelines/convert/hard', async (req, res) => {
    if (writeDenied(res)) {
      return;
    }
    const body = pipelineConvertBodySchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: 'invalid convert body' });
      return;
    }
    const command = await resolveSkillCommand(body.data.commandName);
    if (command === null) {
      res.status(404).json({ error: 'skill command not found' });
      return;
    }
    res.json({ pipeline: hardConvert(command) });
  });

  router.post('/api/pipelines/convert/soft', async (req, res) => {
    if (pipelineEngine === null) {
      res.status(503).json({ error: 'pipelines unavailable' });
      return;
    }
    if (writeDenied(res)) {
      return;
    }
    const body = pipelineConvertBodySchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: 'invalid convert body' });
      return;
    }
    const command = await resolveSkillCommand(body.data.commandName);
    if (command === null) {
      res.status(404).json({ error: 'skill command not found' });
      return;
    }
    try {
      const pipeline = await softConvert(pipelineEngine, command);
      res.json({ pipeline });
    } catch (error) {
      res.status(502).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  return router;
}
