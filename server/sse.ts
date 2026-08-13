import type { Request, Response } from 'express';
import type { RpcStreamEvent } from '../shared/types.js';

const HEARTBEAT_MS = 15_000;

interface SseClient {
  res: Response;
  remote: boolean;
}

/**
 * Fan-out hub: broadcasts pi RPC stream events to all connected SSE clients.
 * P2-02 D: each client remembers whether it connected from a remote
 * (non-loopback) peer; events delivered to remote clients carry a
 * `remote: true` marker so the timeline can distinguish local vs remote
 * origins of an action.
 */
export class SseHub {
  private clients = new Set<SseClient>();
  private heartbeat: NodeJS.Timeout | undefined;

  addClient(req: Request, res: Response): void {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    res.write('retry: 3000\n\n');
    const host = req.headers.host;
    const remote =
      typeof host !== 'string' ||
      host.length === 0 ||
      !(host.startsWith('127.0.0.1') || host.startsWith('localhost') || host.startsWith('[::1]'));
    this.clients.add({ res, remote });
    res.on('close', () => {
      for (const client of this.clients) {
        if (client.res === res) {
          this.clients.delete(client);
          break;
        }
      }
    });
    if (this.heartbeat === undefined) {
      this.heartbeat = setInterval(() => {
        this.broadcastComment();
      }, HEARTBEAT_MS);
    }
  }

  /** Number of connected SSE clients (debug channel). */
  clientCount(): number {
    return this.clients.size;
  }

  /** P2-2: write one chunk; a socket that died between broadcast and its
   *  close handler must not throw into the broadcast loop. */
  private writeClient(client: SseClient, chunk: string): void {
    try {
      client.res.write(chunk);
    } catch {
      this.clients.delete(client);
    }
  }

  broadcast(event: RpcStreamEvent): void {
    if (this.clients.size === 0) {
      return;
    }
    const payload = JSON.stringify(event);
    for (const client of this.clients) {
      if (client.remote) {
        const marked = { ...event, remote: true } as RpcStreamEvent;
        this.writeClient(client, `event: pi\ndata: ${JSON.stringify(marked)}\n\n`);
      } else {
        this.writeClient(client, `event: pi\ndata: ${payload}\n\n`);
      }
    }
  }

  broadcastComment(): void {
    for (const client of this.clients) {
      this.writeClient(client, ': keep-alive\n\n');
    }
  }

  close(): void {
    if (this.heartbeat !== undefined) {
      clearInterval(this.heartbeat);
      this.heartbeat = undefined;
    }
    for (const client of this.clients) {
      client.res.end();
    }
    this.clients.clear();
  }
}
