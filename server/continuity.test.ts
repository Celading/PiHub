import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { HostContinuity } from './continuity.js';

describe('HostContinuity', () => {
  it('persists a random host id without persisting endpoint or credentials', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'pihub-host-'));
    const first = await HostContinuity.create({ home, productVersion: '0.3.2' });
    const second = await HostContinuity.create({ home, productVersion: '0.3.2' });
    expect(second.hostId).toBe(first.hostId);
    expect(second.hostEpoch).not.toBe(first.hostEpoch);
    const stored = await readFile(path.join(home, 'host-identity.json'), 'utf8');
    expect(stored).not.toContain('http://');
    expect(stored).not.toContain('credential');
  });

  it('rejects stale host, session, epoch, revision and generation targets', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'pihub-target-'));
    const continuity = await HostContinuity.create({ home, productVersion: '0.3.2' });
    const targetA = continuity.observeSession('session-a', 'a.jsonl');
    expect(continuity.validate({ actionId: 'a1', target: targetA }).ok).toBe(true);

    const targetB = continuity.observeSession('session-b', 'b.jsonl');
    expect(continuity.validate({ actionId: 'a2', target: targetA })).toMatchObject({
      ok: false,
      reason: 'session-mismatch',
    });
    expect(continuity.validate({
      actionId: 'a3',
      target: { ...targetB, streamEpoch: 'old' },
    })).toMatchObject({ ok: false, reason: 'epoch-mismatch' });
    expect(continuity.validate({
      actionId: 'a4',
      target: { ...targetB, revision: targetB.revision - 1 },
    })).toMatchObject({ ok: false, reason: 'revision-mismatch' });
    expect(continuity.validate({
      actionId: 'a5',
      target: { ...targetB, generation: targetB.generation - 1 },
    })).toMatchObject({ ok: false, reason: 'generation-mismatch' });
    expect(continuity.validate(undefined)).toMatchObject({ ok: false, reason: 'target-required' });
  });

  it('keeps remote continuation blocked unless it is granted independently', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'pihub-manifest-'));
    const continuity = await HostContinuity.create({ home, productVersion: '0.3.2' });
    const manifest = continuity.manifest({
      remotePrompt: true,
      remoteShell: false,
      remoteApprove: false,
      remoteContinue: false,
    });
    expect(manifest.capabilities.find((row) => row.id === 'prompt')?.state).toBe('ready');
    expect(manifest.capabilities.find((row) => row.id === 'continue-session')?.state).toBe('blocked');
    expect(manifest.hostId).not.toBe(manifest.hostEpoch);
    expect(manifest.streamEpoch).not.toBe(manifest.hostEpoch);
  });

  it('invalidates an accepted target after capability revoke or regrant', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'pihub-generation-'));
    const continuity = await HostContinuity.create({ home, productVersion: '0.3.2' });
    const accepted = continuity.observeSession('session-a', 'a.jsonl');
    expect(continuity.validate({ actionId: 'before-revoke', target: accepted }).ok).toBe(true);
    const revoked = continuity.syncGrantGeneration(1);
    expect(revoked.generation).toBeGreaterThan(accepted.generation);
    expect(continuity.validate({ actionId: 'stale', target: accepted })).toMatchObject({
      ok: false,
      reason: 'revision-mismatch',
    });
    const regranted = continuity.syncGrantGeneration(2);
    expect(regranted.generation).toBeGreaterThan(revoked.generation);
  });
});
