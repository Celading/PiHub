import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildRuntimeSurface } from './capabilities.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('runtime surface capability contract', () => {
  it('keeps built-in Pi creation available while exposing dsh as fallback', () => {
    const surface = buildRuntimeSurface({
      mode: 'debug',
      piBinary: '/usr/local/bin/pi',
      piRunning: true,
      dshBinary: '/usr/local/bin/dsh',
      dshRunning: false,
      debug: { bridgeRunning: true },
    });

    expect(surface.defaultEngine).toBe('pi');
    expect(surface.fallbackEngine).toBe('dsh');
    expect(surface.engines.find((entry) => entry.engine === 'pi')).toMatchObject({
      status: 'ready',
      canCreateSession: true,
    });
    expect(surface.engines.find((entry) => entry.engine === 'dsh')).toMatchObject({
      available: true,
      canCreateSession: true,
    });
    expect(surface.debug).toEqual({ bridgeRunning: true });
  });

  it('does not turn configured remote endpoints into a false ready state', () => {
    vi.stubEnv('PIHUB_REMOTE_SERVICE_URL', 'http://192.168.0.107:18384');
    const surface = buildRuntimeSurface({
      mode: 'production',
      piBinary: '/usr/local/bin/pi',
      piRunning: true,
      dshBinary: '',
      dshRunning: false,
    });
    const remote = surface.services.find((entry) => entry.id === 'remote-pihub');
    expect(remote).toMatchObject({
      status: 'degraded',
      canCreateSession: false,
      sessionCreation: 'connection-required',
    });
    expect(remote?.reason).toContain('not proven');
  });

  it('reports missing engines as unavailable instead of silently falling back', () => {
    const surface = buildRuntimeSurface({
      mode: 'production',
      piBinary: '',
      piRunning: false,
      dshBinary: '',
      dshRunning: false,
    });
    expect(surface.engines.every((entry) => entry.status === 'unavailable')).toBe(true);
    expect(surface.services.find((entry) => entry.id === 'builtin-pihub')).toMatchObject({
      canCreateSession: false,
      sessionCreation: 'configuration-required',
    });
  });
});
