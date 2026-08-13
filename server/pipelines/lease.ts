/**
 * v1c: generic exclusive resource lease gate (Lease Gate).
 *
 * A lease is a small JSON file under `<base>/leases/` named by the sha256 of
 * the resource key. Acquisition is atomic via O_EXCL (`wx`): if the file
 * exists with a live expiry and a DIFFERENT owner, the lease is held
 * (conflict → null); expired or corrupt leases are reclaimed by rename and
 * retried once; the SAME owner always takes over (renews) its own lease —
 * the crash-recovery key. An owner that dies is reclaimed by TTL expiry.
 *
 * Single-machine only: the lease file is the fence, no distributed locking.
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export interface Lease {
  resource: string;
  owner: string;
  token: string;
  expiresAt: number;
}

const DEFAULT_TTL_MS = 15 * 60 * 1000;

export class LeaseGate {
  private readonly leasesDir: string;
  private readonly defaultTtlMs: number;

  constructor(baseDir: string, defaultTtlMs: number = DEFAULT_TTL_MS) {
    this.leasesDir = path.join(baseDir, 'leases');
    this.defaultTtlMs = defaultTtlMs;
    mkdirSync(this.leasesDir, { recursive: true });
  }

  /** The lease file for a resource (content-addressed by the resource key). */
  private leasePath(resource: string): string {
    const key = createHash('sha256').update(resource).digest('hex');
    return path.join(this.leasesDir, `${key}.lease`);
  }

  /**
   * Acquires an exclusive lease. Returns the lease, or null on conflict
   * (a live lease held by another owner). The SAME owner always takes over
   * (renews with a fresh token); expired/corrupt leases are reclaimed.
   */
  lease(resource: string, owner: string, ttlMs: number = this.defaultTtlMs): Lease | null {
    const target = this.leasePath(resource);
    const now = Date.now();
    const ttl = Math.max(1, ttlMs);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (!existsSync(target)) {
        const lease: Lease = {
          resource,
          owner,
          token: randomBytes(16).toString('hex'),
          expiresAt: now + ttl,
        };
        try {
          writeFileSync(target, JSON.stringify(lease), { encoding: 'utf8', flag: 'wx' });
          return lease;
        } catch {
          // another process won the create race; fall through to read it
        }
      }
      let existing: Partial<Lease> | null = null;
      try {
        existing = JSON.parse(readFileSync(target, 'utf8')) as Partial<Lease>;
      } catch {
        existing = null; // corrupt lease file
      }
      const existingOwner =
        existing !== null && typeof existing.owner === 'string' ? existing.owner : '';
      const existingExpiresAt =
        existing !== null && typeof existing.expiresAt === 'number' ? existing.expiresAt : 0;
      if (existingOwner === owner) {
        // Same owner → take over: renew with a fresh token.
        const lease: Lease = {
          resource,
          owner,
          token: randomBytes(16).toString('hex'),
          expiresAt: now + ttl,
        };
        try {
          writeFileSync(target, JSON.stringify(lease), 'utf8');
          return lease;
        } catch {
          return null;
        }
      }
      if (existing === null || existingExpiresAt <= now) {
        // Expired or corrupt → reclaim by rename, then retry the create.
        try {
          renameSync(target, `${target}.stale-${String(now)}`);
        } catch {
          // raced; re-check on the next attempt
        }
        continue;
      }
      return null; // live lease held by another owner → conflict
    }
    return null;
  }

  /** Renews a held lease (token-gated). False when expired/released/foreign. */
  renew(lease: Lease): boolean {
    const target = this.leasePath(lease.resource);
    try {
      const existing = JSON.parse(readFileSync(target, 'utf8')) as Partial<Lease>;
      if (existing.token !== lease.token) {
        return false;
      }
      lease.expiresAt = Date.now() + Math.max(1, this.defaultTtlMs);
      const tmpPath = `${target}.tmp`;
      writeFileSync(tmpPath, JSON.stringify(lease), 'utf8');
      renameSync(tmpPath, target);
      return true;
    } catch {
      return false;
    }
  }

  /** Releases a held lease (token-gated). False when already gone/foreign. */
  release(lease: Lease): boolean {
    const target = this.leasePath(lease.resource);
    try {
      const existing = JSON.parse(readFileSync(target, 'utf8')) as Partial<Lease>;
      if (existing.token !== lease.token) {
        return false;
      }
      rmSync(target, { force: true });
      return true;
    } catch {
      return false;
    }
  }

  /** Current live holder of a resource, or null when free/expired/corrupt. */
  status(resource: string): { owner: string; expiresAt: number } | null {
    const target = this.leasePath(resource);
    try {
      const existing = JSON.parse(readFileSync(target, 'utf8')) as Partial<Lease>;
      const owner = typeof existing.owner === 'string' ? existing.owner : '';
      const expiresAt = typeof existing.expiresAt === 'number' ? existing.expiresAt : 0;
      if (owner.length === 0 || expiresAt <= Date.now()) {
        return null;
      }
      return { owner, expiresAt };
    } catch {
      return null;
    }
  }
}
