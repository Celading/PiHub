import type { Response } from 'express';
import type { RpcStreamEvent } from '../shared/types.js';

const HEARTBEAT_MS = 15_000;

/** Fan-out hub: broadcasts pi RPC stream events to all connected SSE clients. */
export class SseHub {
  private clients = new Set<Response>();
  private heartbeat: NodeJS.Timeout | undefined;

  addClient(res: Response): void {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    res.write('retry: 3000\n\n');
    this.clients.add(res);
    res.on('close', () => {
      this.clients.delete(res);
    });
    if (this.heartbeat === undefined) {
      this.heartbeat = setInterval(() => {
        this.broadcastComment();
      }, HEARTBEAT_MS);
    }
  }

  broadcast(event: RpcStreamEvent): void {
    if (this.clients.size === 0) {
      return;
    }
    const payload = JSON.stringify(event);
    for (const client of this.clients) {
      client.write(`event: pi\ndata: ${payload}\n\n`);
    }
  }

  broadcastComment(): void {
    for (const client of this.clients) {
      client.write(': keep-alive\n\n');
    }
  }

  clientCount(): number {
    return this.clients.size;
  }

  close(): void {
    if (this.heartbeat !== undefined) {
      clearInterval(this.heartbeat);
      this.heartbeat = undefined;
    }
    for (const client of this.clients) {
      client.end();
    }
    this.clients.clear();
  }
}
