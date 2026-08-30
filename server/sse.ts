import type { Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import type { RpcStreamEvent } from '../shared/types.js';
import { isRemoteRequest, type RemoteSessionAuthorization } from './security.js';
import type { SessionTargetRef } from './continuity.js';

const HEARTBEAT_MS = 15_000;

interface SseClient {
  res: Response;
  remote: boolean;
  authorization?: RemoteSessionAuthorization;
  expiryTimer?: NodeJS.Timeout;
}

export interface ContinuityEventEnvelope {
  schemaVersion: 1;
  hostId: string;
  streamEpoch: string;
  sequence: number;
  eventId: string;
  kind: string;
  targetRef: SessionTargetRef | null;
  occurredAt: string;
  payloadVersion: 1;
  payload: RpcStreamEvent;
}

export interface EventReplay {
  cursor: string;
  events: ContinuityEventEnvelope[];
  resyncRequired: boolean;
  reason: 'none' | 'epoch-changed' | 'cursor-too-old' | 'invalid-cursor';
}

interface SseHubOptions {
  replayLimit?: number;
  hostId?: string;
  streamEpoch?: string;
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
  private readonly replayLimit: number;
  private hostId: string;
  private streamEpoch: string;
  private sequence = 0;
  private replayWindow: ContinuityEventEnvelope[] = [];
  private targetRef: () => SessionTargetRef | null = () => null;

  constructor(options: SseHubOptions = {}) {
    this.replayLimit = Math.max(1, Math.min(options.replayLimit ?? 512, 4096));
    this.hostId = options.hostId ?? 'unconfigured-host';
    this.streamEpoch = options.streamEpoch ?? randomUUID();
  }

  configureContinuity(input: {
    hostId: string;
    streamEpoch: string;
    targetRef: () => SessionTargetRef | null;
  }): void {
    this.hostId = input.hostId;
    this.streamEpoch = input.streamEpoch;
    this.targetRef = input.targetRef;
    this.sequence = 0;
    this.replayWindow = [];
  }

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
    const lastEventId = req.header('last-event-id');
    if (typeof lastEventId === 'string' && lastEventId.length > 0) {
      const replay = this.replayAfter(lastEventId);
      if (replay.resyncRequired) {
        this.writeClient(
          client,
          `event: resync\ndata: ${JSON.stringify({
            schemaVersion: 1,
            hostId: this.hostId,
            streamEpoch: this.streamEpoch,
            cursor: replay.cursor,
            reason: replay.reason,
          })}\n\n`,
        );
      } else {
        for (const envelope of replay.events) {
          this.writeEnvelope(client, envelope);
        }
      }
    }
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

  currentCursor(): string {
    return `${this.streamEpoch}:${String(this.sequence)}`;
  }

  replayAfter(cursor?: string): EventReplay {
    if (cursor === undefined || cursor.length === 0) {
      return {
        cursor: this.currentCursor(),
        events: [],
        resyncRequired: false,
        reason: 'none',
      };
    }
    const separator = cursor.lastIndexOf(':');
    if (separator <= 0) {
      return {
        cursor: this.currentCursor(),
        events: [],
        resyncRequired: true,
        reason: 'invalid-cursor',
      };
    }
    const epoch = cursor.slice(0, separator);
    const sequence = Number(cursor.slice(separator + 1));
    if (!Number.isSafeInteger(sequence) || sequence < 0) {
      return {
        cursor: this.currentCursor(),
        events: [],
        resyncRequired: true,
        reason: 'invalid-cursor',
      };
    }
    if (epoch !== this.streamEpoch) {
      return {
        cursor: this.currentCursor(),
        events: [],
        resyncRequired: true,
        reason: 'epoch-changed',
      };
    }
    const oldest = this.replayWindow[0]?.sequence ?? this.sequence + 1;
    if (sequence < oldest - 1) {
      return {
        cursor: this.currentCursor(),
        events: [],
        resyncRequired: true,
        reason: 'cursor-too-old',
      };
    }
    return {
      cursor: this.currentCursor(),
      events: this.replayWindow.filter((event) => event.sequence > sequence),
      resyncRequired: false,
      reason: 'none',
    };
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

  private writeEnvelope(client: SseClient, envelope: ContinuityEventEnvelope): void {
    const event = client.remote
      ? ({ ...envelope.payload, remote: true } as RpcStreamEvent)
      : envelope.payload;
    this.writeClient(
      client,
      `id: ${envelope.eventId}\nevent: pi\ndata: ${JSON.stringify(event)}\n\n`,
    );
  }

  broadcast(event: RpcStreamEvent): void {
    this.sequence += 1;
    const envelope: ContinuityEventEnvelope = {
      schemaVersion: 1,
      hostId: this.hostId,
      streamEpoch: this.streamEpoch,
      sequence: this.sequence,
      eventId: this.currentCursor(),
      kind: event.type,
      targetRef: this.targetRef(),
      occurredAt: new Date().toISOString(),
      payloadVersion: 1,
      payload: event,
    };
    this.replayWindow.push(envelope);
    if (this.replayWindow.length > this.replayLimit) {
      this.replayWindow.splice(0, this.replayWindow.length - this.replayLimit);
    }
    for (const client of this.clients) {
      this.writeEnvelope(client, envelope);
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
