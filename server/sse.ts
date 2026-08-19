import type { Request, Response } from 'express';
import type { RpcStreamEvent } from '../shared/types.js';
import { isRemoteRequest, type RemoteSessionAuthorization } from './security.js';

const HEARTBEAT_MS = 15_000;

interface SseClient {
  res: Response;
  remote: boolean;
  authorization?: RemoteSessionAuthorization;
  expiryTimer?: NodeJS.Timeout;
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

  addClient(req: Request, res: Response, authorization?: RemoteSessionAuthorization): void {
    const remote = isRemoteRequest(req);
    if (
      remote &&
      (authorization === undefined ||
        authorization.expiresAt <= Date.now() ||
        !authorization.isValid())
    ) {
      res.status(403).end();
      return;
    }
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    res.write('retry: 3000\n\n');
    const client: SseClient = {
      res,
      remote,
      ...(authorization === undefined ? {} : { authorization }),
    };
    if (authorization !== undefined) {
      client.expiryTimer = setTimeout(() => {
        this.removeClient(client, true);
      }, Math.max(0, authorization.expiresAt - Date.now()));
    }
    this.clients.add(client);
    res.on('close', () => {
      for (const current of this.clients) {
        if (current.res === res) {
          this.removeClient(current, false);
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

  closeRemoteSession(sessionId: string): void {
    for (const client of [...this.clients]) {
      if (client.authorization?.sessionId === sessionId) {
        this.removeClient(client, true);
      }
    }
  }

  private removeClient(client: SseClient, end: boolean): void {
    if (client.expiryTimer !== undefined) {
      clearTimeout(client.expiryTimer);
    }
    const removed = this.clients.delete(client);
    if (end && removed) {
      client.res.end();
    }
  }

  private isAuthorized(client: SseClient): boolean {
    if (!client.remote) {
      return true;
    }
    const authorization = client.authorization;
    if (
      authorization === undefined ||
      authorization.expiresAt <= Date.now() ||
      !authorization.isValid()
    ) {
      this.removeClient(client, true);
      return false;
    }
    return true;
  }

  /** P2-2: write one chunk; a socket that died between broadcast and its
   *  close handler must not throw into the broadcast loop. */
  private writeClient(client: SseClient, chunk: string): void {
    if (!this.isAuthorized(client)) {
      return;
    }
    try {
      client.res.write(chunk);
    } catch {
      this.removeClient(client, false);
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
    for (const client of [...this.clients]) {
      this.removeClient(client, true);
    }
  }
}
