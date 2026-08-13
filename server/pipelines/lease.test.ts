import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LeaseGate, type Lease } from './lease.js';

let tempDir: string | undefined;

async function makeGate(ttlMs = 15 * 60 * 1000): Promise<LeaseGate> {
  tempDir = await mkdtemp(path.join(os.tmpdir(), 'pi-panel-lease-test-'));
  return new LeaseGate(tempDir, ttlMs);
}

/** Non-null helper (the project forbids `!` assertions). */
function must(lease: Lease | null): Lease {
  if (lease === null) {
    throw new Error('expected a lease');
  }
  return lease;
}

afterEach(async () => {
  if (tempDir !== undefined) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('lease gate (v1c)', () => {
  it('acquires an exclusive lease and reports its status', async () => {
    const gate = await makeGate();
    const lease = must(gate.lease('device:1', 'run-1'));
    expect(lease.owner).toBe('run-1');
    expect(lease.token.length).toBeGreaterThan(0);
    expect(lease.expiresAt).toBeGreaterThan(Date.now());
    const status = gate.status('device:1');
    expect(status?.owner).toBe('run-1');
  });

  it('conflicts with a live lease held by another owner', async () => {
    const gate = await makeGate();
    expect(must(gate.lease('port:8123', 'run-1')).owner).toBe('run-1');
    expect(gate.lease('port:8123', 'run-2')).toBeNull();
  });

  it('reclaims an expired lease for a new owner', async () => {
    const gate = await makeGate(30);
    expect(must(gate.lease('sign:cert', 'run-1')).owner).toBe('run-1');
    await sleep(40); // past the 30ms TTL
    const b = gate.lease('sign:cert', 'run-2');
    expect(b).not.toBeNull();
    expect(b?.owner).toBe('run-2');
  });

  it('lets the same owner take over its own lease (crash recovery)', async () => {
    const gate = await makeGate();
    const a = must(gate.lease('execution', 'run-1'));
    const b = must(gate.lease('execution', 'run-1')); // same owner → take over
    expect(b.token).not.toBe(a.token); // fresh token
  });

  it('renew refreshes expiry and is token-gated', async () => {
    const gate = await makeGate(1000);
    const a = must(gate.lease('build-cache:k1', 'run-1'));
    const before = a.expiresAt;
    await sleep(10);
    expect(gate.renew(a)).toBe(true);
    expect(a.expiresAt).toBeGreaterThan(before);
    // a forged token cannot renew
    const forged: Lease = { ...a, token: 'forged' };
    expect(gate.renew(forged)).toBe(false);
  });

  it('release frees the resource and is token-gated', async () => {
    const gate = await makeGate();
    const a = must(gate.lease('dir:/work', 'run-1'));
    const forged: Lease = { ...a, token: 'forged' };
    expect(gate.release(forged)).toBe(false);
    expect(gate.status('dir:/work')).not.toBeNull();
    expect(gate.release(a)).toBe(true);
    expect(gate.status('dir:/work')).toBeNull();
    // another owner can now acquire
    expect(must(gate.lease('dir:/work', 'run-2')).owner).toBe('run-2');
  });

  it('is exclusive across gate instances on the same base dir', async () => {
    const gateA = await makeGate();
    if (tempDir === undefined) {
      throw new Error('tempDir missing');
    }
    const gateB = new LeaseGate(tempDir);
    expect(must(gateA.lease('execution', 'run-1')).owner).toBe('run-1');
    expect(gateB.lease('execution', 'run-2')).toBeNull();
    // the same owner takes over from the other instance (recovery path)
    expect(must(gateB.lease('execution', 'run-1')).owner).toBe('run-1');
  });

  it('isolation: different resources never conflict', async () => {
    const gate = await makeGate();
    expect(must(gate.lease('port:1', 'run-1')).owner).toBe('run-1');
    expect(must(gate.lease('port:2', 'run-2')).owner).toBe('run-2');
    expect(must(gate.lease('device:x', 'run-3')).owner).toBe('run-3');
  });
});
