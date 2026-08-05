import { readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import express from 'express';
import { z } from 'zod';
import { modelStoreFileSchema, settingsFileSchema } from '../shared/schemas.js';
import type { RpcBridge } from './rpc-bridge.js';
import type { SessionStore } from './sessions.js';
import type { SseHub } from './sse.js';

const AGENT_DIR = path.join(os.homedir(), '.pi', 'agent');

const promptBodySchema = z.object({
  message: z.string().min(1).max(32_000),
  streamingBehavior: z.enum(['steer', 'followUp']).optional(),
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

async function readJson(fileName: string): Promise<unknown> {
  try {
    const content = await readFile(fileName, 'utf8');
    return JSON.parse(content) as unknown;
  } catch {
    return undefined;
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
    const response = await bridge.send({
      type: 'prompt',
      message: body.data.message,
      ...(body.data.streamingBehavior !== undefined
        ? { streamingBehavior: body.data.streamingBehavior }
        : {}),
    });
    res.json(response);
  });

  router.post('/api/rpc/steer', async (req, res) => {
    const body = steerBodySchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: 'invalid steer body' });
      return;
    }
    const response = await bridge.send({
      type: 'steer',
      message: body.data.message,
    });
    res.json(response);
  });

  router.post('/api/rpc/abort', async (_req, res) => {
    const response = await bridge.send({ type: 'abort' });
    res.json(response);
  });

  router.post('/api/rpc/model', async (req, res) => {
    const body = modelBodySchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: 'invalid model body' });
      return;
    }
    const response = await bridge.send({
      type: 'set_model',
      provider: body.data.provider,
      modelId: body.data.modelId,
    });
    res.json(response);
  });

  router.post('/api/rpc/thinking', async (req, res) => {
    const body = thinkingBodySchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: 'invalid thinking level' });
      return;
    }
    const response = await bridge.send({
      type: 'set_thinking_level',
      level: body.data.level,
    });
    res.json(response);
  });

  router.get('/api/rpc/state', async (_req, res) => {
    const response = await bridge.send({ type: 'get_state' });
    if (!response.success) {
      res.status(502).json({ error: 'pi state unavailable' });
      return;
    }
    res.json(response.data);
  });

  router.get('/api/rpc/messages', async (_req, res) => {
    const response = await bridge.send({ type: 'get_messages' });
    if (!response.success) {
      res.status(502).json({ error: 'pi messages unavailable' });
      return;
    }
    res.json(response.data);
  });

  router.get('/api/events', (req, res) => {
    hub.addClient(res);
    req.on('close', () => {
      // Client disconnect is handled inside the hub via res 'close'.
    });
  });

  return router;
}
