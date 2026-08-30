import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const CONTINUITY_SCHEMA_VERSION = 1 as const;
export const CONTINUITY_CONTRACT_VERSION = '1.0' as const;

export interface CapabilityEntry {
  id: string;
  state: 'ready' | 'blocked' | 'unavailable';
  scope: 'host' | 'session';
  contractVersion: string;
  grantGeneration: number;
  expiresAt: string | null;
  reason: string | null;
}

export interface HostManifest {
  schemaVersion: typeof CONTINUITY_SCHEMA_VERSION;
  contractVersion: typeof CONTINUITY_CONTRACT_VERSION;
  hostId: string;
  hostEpoch: string;
  streamEpoch: string;
  displayLabel: string;
  productVersion: string;
  platformClass: NodeJS.Platform;
  supportedTransports: readonly ['http', 'sse', 'cursor-pull'];
  capabilities: CapabilityEntry[];
  serverTime: string;
}

export interface SessionTargetRef {
  hostId: string;
  sessionRef: string;
  streamEpoch: string;
  revision: number;
  generation: number;
}

export interface ActionTarget {
  actionId: string;
  target: SessionTargetRef;
}

export interface ActionReceipt {
  schemaVersion: typeof CONTINUITY_SCHEMA_VERSION;
  actionId: string;
  accepted: true;
  target: SessionTargetRef;
  acceptedAt: string;
}

export type TargetMismatchReason =
  | 'target-required'
  | 'host-mismatch'
  | 'session-mismatch'
  | 'epoch-mismatch'
  | 'revision-mismatch'
  | 'generation-mismatch';

export interface TargetValidation {
  ok: boolean;
  target: SessionTargetRef;
  reason?: TargetMismatchReason;
}

interface PersistedHostIdentity {
  schemaVersion: typeof CONTINUITY_SCHEMA_VERSION;
  hostId: string;
  createdAt: string;
}

export interface HostContinuityOptions {
  home: string;
  productVersion: string;
  displayLabel?: string;
  platformClass?: NodeJS.Platform;
}

const HOST_IDENTITY_FILE = 'host-identity.json';

function validHostIdentity(value: unknown): value is PersistedHostIdentity {
  if (typeof value !== 'object' || value === null) return false;
  const row = value as Record<string, unknown>;
  return (
    row['schemaVersion'] === CONTINUITY_SCHEMA_VERSION &&
    typeof row['hostId'] === 'string' &&
    row['hostId'].length >= 16 &&
    typeof row['createdAt'] === 'string'
  );
}

async function loadOrCreateHostIdentity(home: string): Promise<PersistedHostIdentity> {
  await mkdir(home, { recursive: true });
  const identityPath = path.join(home, HOST_IDENTITY_FILE);
  try {
    const parsed = JSON.parse(await readFile(identityPath, 'utf8')) as unknown;
    if (validHostIdentity(parsed)) return parsed;
  } catch {
    // Missing or invalid identity is replaced with a fresh random identity.
  }

  const identity: PersistedHostIdentity = {
    schemaVersion: CONTINUITY_SCHEMA_VERSION,
    hostId: randomUUID(),
    createdAt: new Date().toISOString(),
  };
  const temporary = `${identityPath}.${String(process.pid)}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(identity, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  await rename(temporary, identityPath);
  return identity;
}

/**
 * Process-local authority for host identity and write targeting. The stable
 * host id persists, while host/stream epochs intentionally change on restart.
 */
export class HostContinuity {
  readonly hostId: string;
  readonly hostEpoch = randomUUID();
  readonly streamEpoch = randomUUID();
  private readonly productVersion: string;
  private readonly displayLabel: string;
  private readonly platformClass: NodeJS.Platform;
  private activeSessionRef = '';
  private activeSessionFile = '';
  private generation = 0;
  private revision = 0;
  private observedGrantGeneration = 0;

  private constructor(identity: PersistedHostIdentity, options: HostContinuityOptions) {
    this.hostId = identity.hostId;
    this.productVersion = options.productVersion;
    this.displayLabel = options.displayLabel?.trim() || 'PiHub Host';
    this.platformClass = options.platformClass ?? process.platform;
  }

  static async create(options: HostContinuityOptions): Promise<HostContinuity> {
    return new HostContinuity(await loadOrCreateHostIdentity(options.home), options);
  }

  manifest(input: {
    remotePrompt: boolean;
    remoteShell: boolean;
    remoteApprove: boolean;
    remoteContinue: boolean;
    grantGeneration?: number;
    expiresAt?: string | null;
  }): HostManifest {
    const grantGeneration = input.grantGeneration ?? 0;
    this.syncGrantGeneration(grantGeneration);
    const expiresAt = input.expiresAt ?? null;
    const capability = (id: string, ready: boolean, scope: 'host' | 'session'): CapabilityEntry => ({
      id,
      state: ready ? 'ready' : 'blocked',
      scope,
      contractVersion: CONTINUITY_CONTRACT_VERSION,
      grantGeneration,
      expiresAt,
      reason: ready ? null : 'not granted by host',
    });
    return {
      schemaVersion: CONTINUITY_SCHEMA_VERSION,
      contractVersion: CONTINUITY_CONTRACT_VERSION,
      hostId: this.hostId,
      hostEpoch: this.hostEpoch,
      streamEpoch: this.streamEpoch,
      displayLabel: this.displayLabel,
      productVersion: this.productVersion,
      platformClass: this.platformClass,
      supportedTransports: ['http', 'sse', 'cursor-pull'],
      capabilities: [
        capability('browse', true, 'host'),
        capability('prompt', input.remotePrompt, 'session'),
        capability('shell', input.remoteShell, 'session'),
        capability('approve', input.remoteApprove, 'session'),
        capability('continue-session', input.remoteContinue, 'session'),
        capability('resumable-events', true, 'host'),
      ],
      serverTime: new Date().toISOString(),
    };
  }

  observeSession(sessionRef: string, sessionFile: string): SessionTargetRef {
    if (sessionRef !== this.activeSessionRef || sessionFile !== this.activeSessionFile) {
      this.activeSessionRef = sessionRef;
      this.activeSessionFile = sessionFile;
      this.generation += 1;
      this.revision += 1;
    }
    return this.currentTarget();
  }

  /** Capability revoke/regrant invalidates every earlier action target. */
  syncGrantGeneration(grantGeneration: number): SessionTargetRef {
    if (grantGeneration !== this.observedGrantGeneration) {
      this.observedGrantGeneration = grantGeneration;
      this.generation += 1;
      this.revision += 1;
    }
    return this.currentTarget();
  }

  currentTarget(): SessionTargetRef {
    return {
      hostId: this.hostId,
      sessionRef: this.activeSessionRef,
      streamEpoch: this.streamEpoch,
      revision: this.revision,
      generation: this.generation,
    };
  }

  currentSessionFile(): string {
    return this.activeSessionFile;
  }

  receipt(actionId: string): ActionReceipt {
    return {
      schemaVersion: CONTINUITY_SCHEMA_VERSION,
      actionId,
      accepted: true,
      target: this.currentTarget(),
      acceptedAt: new Date().toISOString(),
    };
  }

  validate(action: ActionTarget | undefined): TargetValidation {
    const current = this.currentTarget();
    if (action === undefined) return { ok: false, target: current, reason: 'target-required' };
    const candidate = action.target;
    if (candidate.hostId !== current.hostId) return { ok: false, target: current, reason: 'host-mismatch' };
    if (candidate.sessionRef !== current.sessionRef) return { ok: false, target: current, reason: 'session-mismatch' };
    if (candidate.streamEpoch !== current.streamEpoch) return { ok: false, target: current, reason: 'epoch-mismatch' };
    if (candidate.revision !== current.revision) return { ok: false, target: current, reason: 'revision-mismatch' };
    if (candidate.generation !== current.generation) return { ok: false, target: current, reason: 'generation-mismatch' };
    return { ok: true, target: current };
  }
}
