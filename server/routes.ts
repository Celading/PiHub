import { readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import express from 'express';
import { z } from 'zod';
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
import { DEMO_RUNNING_ID } from './providers/mock-session-provider.js';
import type { RpcResponse, PiCommand } from '../shared/types.js';
import type { SessionStore } from './sessions.js';
import type { SseHub } from './sse.js';
import type { PipelineEngine } from './pipelines/engine.js';
import type { PipelineStore } from './pipelines/store.js';
import { hardConvert, softConvert } from './pipelines/convert.js';

const AGENT_DIR = path.join(os.homedir(), '.pi', 'agent');

const promptImageSchema = z.object({
  type: z.literal('image'),
  data: z.string(),
  mimeType: z.string().optional(),
});

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
  debugState?: () => Record<string, unknown>;
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

  // Demo mode is a read-only showcase: guard every RPC write path.
  const writeDenied = (res: express.Response): boolean => {
    if (mode !== 'demo') {
      return false;
    }
    res.status(503).json({ error: 'demo mode: read-only showcase, RPC writes disabled' });
    return true;
  };

  router.get('/api/mode', (_req, res) => {
    res.json({ mode });
  });

  if (demoMachine !== null) {
    router.get('/api/demo/state', (_req, res) => {
      res.json({ phase: demoMachine.getPhase() });
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
  }

  if (mode === 'debug') {
    router.get('/api/debug/state', (_req, res) => {
      res.json(options?.debugState?.() ?? {});
    });
  }

  router.get('/api/health', (_req, res) => {
    res.json({
      status: 'ok',
      name: 'pi-panel',
      version: '0.1.0',
      time: new Date().toISOString(),
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
    if (writeDenied(res)) {
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
      const response = await fetch(
        `https://pi.dev/api/models/providers/${encodeURIComponent(provider)}`,
        {
          headers: { accept: 'application/json', 'User-Agent': 'pihub/1.0' },
          signal: AbortSignal.timeout(12000),
        },
      );
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
    if (writeDenied(res)) {
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
    if (writeDenied(res)) {
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
      res.json(response);
    } catch (error) {
      res.status(502).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post('/api/rpc/new_session', async (_req, res) => {
    if (writeDenied(res)) {
      return;
    }
    try {
      const response = await bridge.send({ type: 'new_session' });
      res.json(response);
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
    if (writeDenied(res)) {
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

  router.get('/api/rpc/session-stats', async (_req, res) => {
    await withBridge(res, () => bridge.send({ type: 'get_session_stats' }));
  });

  // Extension UI protocol (P1-01): pending dialog requests + answering.
  router.get('/api/rpc/ui-requests', (_req, res) => {
    res.json({ requests: bridge.getPendingUiRequests() });
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

  router.get('/api/events', (req, res) => {
    hub.addClient(res);
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
    res.json({ runs: pipelineStore.readRunLog(req.params.id) });
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
    const run = pipelineEngine.start(pipeline, body.data.input ?? '', context);
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
