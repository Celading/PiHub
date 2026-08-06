import { readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import express from 'express';
import { z } from 'zod';
import { modelStoreFileSchema, settingsFileSchema, uiRespondBodySchema } from '../shared/schemas.js';
import type { RpcBridge } from './rpc-bridge.js';
import type { RpcResponse } from '../shared/types.js';
import type { SessionStore } from './sessions.js';
import type { SseHub } from './sse.js';

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
    res.json(response.data);
  } catch (error) {
    res.status(502).json({ error: error instanceof Error ? error.message : String(error) });
  }
}

export function createRouter(
  bridge: RpcBridge,
  sessions: SessionStore,
  hub: SseHub,
): express.Router {
  const router = express.Router();

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

  // Session deletion (no pi RPC): only the file name inside the sessions
  // root is accepted (path-traversal guard) and only .jsonl files.
  router.post('/api/sessions/delete', async (req, res) => {
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
    const target = path.join(
      os.homedir(),
      '.pi',
      'agent',
      'sessions',
      base,
    );
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

  router.post('/api/rpc/prompt', async (req, res) => {
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
    const body = steerBodySchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: 'invalid steer body' });
      return;
    }
    await withBridge(res, () => bridge.send({ type: 'steer', message: body.data.message }));
  });

  router.post('/api/rpc/abort', async (_req, res) => {
    await withBridge(res, () => bridge.send({ type: 'abort' }));
  });

  router.post('/api/rpc/model', async (req, res) => {
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
    await withBridge(res, () => bridge.send({ type: 'get_state' }));
  });

  router.get('/api/rpc/messages', async (_req, res) => {
    await withBridge(res, () => bridge.send({ type: 'get_messages' }));
  });

  router.post('/api/rpc/switch_session', async (req, res) => {
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
    try {
      const response = await bridge.send({ type: 'new_session' });
      res.json(response);
    } catch (error) {
      res.status(502).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post('/api/rpc/fork', async (req, res) => {
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
    try {
      const response = await bridge.send({ type: 'clone' });
      res.json(response);
    } catch (error) {
      res.status(502).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post('/api/rpc/steering-mode', async (req, res) => {
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
    try {
      const response = await bridge.send({ type: 'cycle_model' });
      res.json(response);
    } catch (error) {
      res.status(502).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post('/api/rpc/rename', async (req, res) => {
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
    try {
      const response = await bridge.send({ type: 'abort_bash' });
      res.json(response);
    } catch (error) {
      res.status(502).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post('/api/rpc/compact', async (_req, res) => {
    try {
      const response = await bridge.send({ type: 'compact' });
      res.json(response);
    } catch (error) {
      res.status(502).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post('/api/rpc/auto-compaction', async (req, res) => {
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
    try {
      const response = await bridge.send({ type: 'export_html' });
      res.json(response);
    } catch (error) {
      res.status(502).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post('/api/settings/model', async (req, res) => {
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
      res.json({ success: true });
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

  return router;
}
