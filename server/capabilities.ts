/**
 * Runtime capability probing for the Node host. Each runtime
 * (pi/codex/dsh) reports binary resolvability, version, session home, and
 * whether a real private home (~) is reachable — the same writable-home
 * probe the device uses for its private space.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { resolveDshBinary } from './adapters/dsh-adapter.js';
import { resolveCodexBinary } from './adapters/codex-adapter.js';

export interface AgentRuntimeInfo {
  kind: 'pi' | 'codex' | 'dsh';
  /** Whether the CLI binary resolves on PATH (or via explicit env). */
  available: boolean;
  binary: string | null;
  version: string | null;
  sessionDir: string | null;
  home: string | null;
}

export interface RuntimeCapabilities {
  agents: AgentRuntimeInfo[];
  /** True when the real user home is writable (private space reachable). */
  privateSpace: boolean;
  home: string;
  nodeVersion: string;
}

export type CapabilityStatus = 'ready' | 'degraded' | 'blocked' | 'unavailable';
export type ServiceTargetKind = 'builtin' | 'local' | 'remote' | 'nearby';

export interface EngineSelfTest {
  engine: 'pi' | 'dsh';
  label: string;
  status: CapabilityStatus;
  available: boolean;
  ready: boolean;
  canCreateSession: boolean;
  checks: string[];
  reason: string | null;
}

export interface ServiceTargetCapability {
  id: 'builtin-pihub' | 'local-service' | 'remote-pihub' | 'nearby-pihub';
  kind: ServiceTargetKind;
  label: string;
  status: CapabilityStatus;
  sessionCreation: 'supported' | 'configuration-required' | 'connection-required';
  canCreateSession: boolean;
  reason: string | null;
  endpoint: string | null;
}

export interface RuntimeSurface {
  mode: 'production' | 'debug' | 'demo';
  checkedAt: string;
  engines: EngineSelfTest[];
  services: ServiceTargetCapability[];
  defaultEngine: 'pi';
  fallbackEngine: 'dsh';
  debug: Record<string, unknown> | null;
}

export interface RuntimeSurfaceInput {
  mode: RuntimeSurface['mode'];
  piBinary: string;
  piRunning: boolean;
  dshBinary: string;
  dshRunning: boolean;
  debug?: Record<string, unknown>;
}

function resolveBinary(envName: string, binaryName: string): string {
  const fromEnv = process.env[envName];
  if (fromEnv !== undefined && fromEnv.length > 0) {
    return fromEnv;
  }
  try {
    const result = spawnSync('which', [binaryName], { encoding: 'utf8' });
    if (result.status === 0 && typeof result.stdout === 'string') {
      const candidate = result.stdout.trim().split('\n')[0];
      if (candidate !== undefined && candidate.length > 0) {
        return candidate;
      }
    }
  } catch {
    // not on PATH
  }
  return '';
}

/** Version from a package.json beside the binary (best effort, follows
 *  symlinks — npm global bins link into lib/node_modules). */
export function versionFromBinary(binary: string): string | null {
  try {
    const resolved = fs.realpathSync(binary);
    const manifestPath = path.join(path.dirname(resolved), '..', 'package.json');
    if (fs.existsSync(manifestPath)) {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as { version?: unknown };
      if (typeof manifest.version === 'string') {
        return manifest.version;
      }
    }
    const localManifest = path.join(path.dirname(resolved), 'package.json');
    if (fs.existsSync(localManifest)) {
      const manifest = JSON.parse(fs.readFileSync(localManifest, 'utf8')) as { version?: unknown };
      if (typeof manifest.version === 'string') {
        return manifest.version;
      }
    }
  } catch {
    // unknown
  }
  return null;
}

/** A packaged runtime may expose a JavaScript wrapper rather than the package
 *  bin; resolve its pinned manifest from PIHUB_PI_ROOT first. */
export function piVersionFromRuntime(binary: string): string | null {
  const root = process.env.PIHUB_PI_ROOT;
  if (root !== undefined && root.length > 0) {
    try {
      const manifest = JSON.parse(
        fs.readFileSync(
          path.join(root, 'node_modules', '@mariozechner', 'pi-coding-agent', 'package.json'),
          'utf8',
        ),
      ) as { version?: unknown };
      if (typeof manifest.version === 'string') {
        return manifest.version;
      }
    } catch {
      // fall through to the ordinary binary-relative probe
    }
  }
  return versionFromBinary(binary);
}

function dshVersion(): string | null {
  try {
    const home = process.env.DSH_HOME;
    if (home !== undefined && home.length > 0) {
      const manifest = JSON.parse(
        fs.readFileSync(path.join(home, 'vendor', 'dsh', 'package.json'), 'utf8'),
      ) as { version?: unknown };
      if (typeof manifest.version === 'string') {
        return manifest.version;
      }
    }
  } catch {
    // fall through
  }
  const binary = resolveDshBinary();
  if (binary.length > 0) {
    return versionFromBinary(binary);
  }
  return null;
}

/** Writable-home probe for a real home reachable without extra permissions. */
export function probePrivateSpace(): { privateSpace: boolean; home: string } {
  const home = os.homedir();
  if (home.length === 0 || home.startsWith('/data/storage/')) {
    return { privateSpace: false, home };
  }
  try {
    const probeFile = path.join(home, '.pihub-home-probe');
    fs.writeFileSync(probeFile, 'ok', 'utf8');
    fs.rmSync(probeFile, { force: true });
    return { privateSpace: true, home };
  } catch {
    return { privateSpace: false, home };
  }
}

/** Probe every known agent runtime + the shared host facts. */
export function probeCapabilities(): RuntimeCapabilities {
  const piBinary = resolveBinary('PI_BINARY', 'pi');
  const codexBinary = resolveCodexBinary();
  const dshBinary = resolveDshBinary();
  const homeInfo = probePrivateSpace();

  const agents: AgentRuntimeInfo[] = [
    {
      kind: 'pi',
      available: piBinary.length > 0,
      binary: piBinary.length > 0 ? piBinary : null,
      version: piBinary.length > 0 ? piVersionFromRuntime(piBinary) : null,
      sessionDir: path.join(os.homedir(), '.pi', 'agent', 'sessions'),
      home: process.env.PI_HOME ?? null,
    },
    {
      kind: 'codex',
      available: codexBinary.length > 0,
      binary: codexBinary.length > 0 ? codexBinary : null,
      version: codexBinary.length > 0 ? versionFromBinary(codexBinary) : null,
      sessionDir: path.join(os.homedir(), '.codex', 'sessions'),
      home: process.env.CODEX_HOME ?? null,
    },
    {
      kind: 'dsh',
      available: dshBinary.length > 0,
      binary: dshBinary.length > 0 ? dshBinary : null,
      version: dshVersion(),
      sessionDir:
        process.env.DSH_HOME !== undefined && process.env.DSH_HOME.length > 0
          ? path.join(process.env.DSH_HOME, 'sessions')
          : path.join(os.homedir(), '.dsh', 'sessions'),
      home: process.env.DSH_HOME ?? null,
    },
  ];

  return {
    agents,
    privateSpace: homeInfo.privateSpace,
    home: homeInfo.home,
    nodeVersion: process.versions.node,
  };
}

function configuredEndpoint(name: string): string | null {
  const value = process.env[name]?.trim();
  return value === undefined || value.length === 0 ? null : value;
}

/**
 * Builds the read-only capability contract consumed by the dashboard and the
 * new-session gate. It deliberately reports configured-but-disconnected
 * service targets instead of pretending that a URL is a live connection.
 */
export function buildRuntimeSurface(input: RuntimeSurfaceInput): RuntimeSurface {
  const piAvailable = input.piBinary.length > 0;
  const dshAvailable = input.dshBinary.length > 0;
  const localEndpoint = configuredEndpoint('PIHUB_LOCAL_SERVICE_URL');
  const remoteEndpoint = configuredEndpoint('PIHUB_REMOTE_SERVICE_URL');
  const nearbyEndpoint = configuredEndpoint('PIHUB_NEARBY_URLS');
  const piStatus: CapabilityStatus = piAvailable && input.piRunning ? 'ready' : piAvailable ? 'degraded' : 'unavailable';
  const dshStatus: CapabilityStatus = dshAvailable ? 'ready' : 'unavailable';
  const engineChecks = (binary: string, running: boolean): string[] => [
    binary.length > 0 ? 'binary-resolved' : 'binary-missing',
    running ? 'adapter-running' : 'adapter-idle',
  ];

  const service = (
    id: ServiceTargetCapability['id'],
    kind: ServiceTargetKind,
    label: string,
    endpoint: string | null,
  ): ServiceTargetCapability => {
    if (id === 'builtin-pihub') {
      return {
        id,
        kind,
        label,
        status: piStatus,
        sessionCreation: piAvailable ? 'supported' : 'configuration-required',
        canCreateSession: piAvailable,
        reason: piAvailable ? null : 'Pi Agent binary is not available on this host',
        endpoint: null,
      };
    }
    const connected = endpoint !== null;
    return {
      id,
      kind,
      label,
      status: connected ? 'degraded' : 'unavailable',
      sessionCreation: 'connection-required',
      canCreateSession: false,
      reason: connected ? 'endpoint configured; connection and pairing are not proven' : 'no endpoint configured',
      endpoint,
    };
  };

  return {
    mode: input.mode,
    checkedAt: new Date().toISOString(),
    engines: [
      {
        engine: 'pi',
        label: 'Pi Agent',
        status: piStatus,
        available: piAvailable,
        ready: piAvailable && input.piRunning,
        canCreateSession: piAvailable,
        checks: engineChecks(input.piBinary, input.piRunning),
        reason: piAvailable ? (input.piRunning ? null : 'Pi bridge is starting or idle') : 'PI_BINARY is not resolvable',
      },
      {
        engine: 'dsh',
        label: 'DeepSeek Harness (fallback)',
        status: dshStatus,
        available: dshAvailable,
        ready: dshAvailable && input.dshRunning,
        canCreateSession: dshAvailable,
        checks: engineChecks(input.dshBinary, input.dshRunning),
        reason: dshAvailable ? null : 'dsh fallback binary is not resolvable',
      },
    ],
    services: [
      service('builtin-pihub', 'builtin', 'Built-in PiHub', null),
      service('local-service', 'local', 'Local service', localEndpoint),
      service('remote-pihub', 'remote', 'Remote PiHub', remoteEndpoint),
      service('nearby-pihub', 'nearby', 'Nearby PiHub', nearbyEndpoint),
    ],
    defaultEngine: 'pi',
    fallbackEngine: 'dsh',
    debug: input.mode === 'debug' ? input.debug ?? {} : null,
  };
}
