/**
 * Agent management — panel-side startup/config for pi/codex/dsh.
 *
 * Configuration persists to <pihub-home>/agents.json (binary overrides,
 * enable toggles). Lifecycle semantics are honest per agent:
 *  - pi:    a resident RPC child — restart() takes effect immediately;
 *  - codex: per-prompt `codex exec` — no resident process, only availability;
 *  - dsh:   per-task headless runs — availability only (packaged installs may ship the
 *           core, other forms use a locally installed `dsh` CLI).
 * Binary overrides apply from the next panel restart (the adapters read them
 * at boot); the setting page states this explicitly.
 */
import fs from 'node:fs';
import path from 'node:path';
import { piVersionFromRuntime, versionFromBinary } from './capabilities.js';

export type AgentKind = 'pi' | 'codex' | 'dsh' | 'claude';

export interface AgentConfig {
  binary?: string;
  enabled?: boolean;
}

export interface AgentManageRow {
  kind: AgentKind;
  available: boolean;
  enabled: boolean;
  running: boolean;
  binary: string | null;
  version: string | null;
  /** Per-agent lifecycle note (honest boundaries). */
  lifecycle: string;
  config: AgentConfig;
}

export interface AgentsManagerOptions {
  home: string;
  /** Effective binary for the given kind (env/boot resolution). */
  resolveBinary: (kind: AgentKind) => string;
  /** Restart the pi RPC bridge immediately. */
  restartPi?: () => Promise<{ success: boolean; error?: string }>;
  /** Whether the pi bridge is currently running. */
  isPiRunning?: () => boolean;
}

export function createAgentsManager(options: AgentsManagerOptions) {  const configFile = path.join(options.home, 'agents.json');

  function loadConfig(): Record<string, AgentConfig> {
    try {
      const raw = JSON.parse(fs.readFileSync(configFile, 'utf8')) as Record<string, unknown>;
      const out: Record<string, AgentConfig> = {};
      for (const kind of ['pi', 'codex', 'dsh', 'claude'] as const) {
        const entry = raw[kind];
        if (entry !== null && typeof entry === 'object') {
          const record = entry as Record<string, unknown>;
          const cfg: AgentConfig = {};
          if (typeof record['binary'] === 'string') {
            cfg.binary = record['binary'];
          }
          if (typeof record['enabled'] === 'boolean') {
            cfg.enabled = record['enabled'];
          }
          out[kind] = cfg;
        }
      }
      return out;
    } catch {
      return {};
    }
  }

  function saveConfig(config: Record<string, AgentConfig>): void {
    try {
      fs.mkdirSync(options.home, { recursive: true });
      fs.writeFileSync(configFile, JSON.stringify(config, null, 2), 'utf8');
    } catch {
      // best-effort persistence
    }
  }

  let config = loadConfig();

  function effectiveBinary(kind: AgentKind): string {
    const override = config[kind]?.binary;
    if (override !== undefined && override.length > 0) {
      return override;
    }
    return options.resolveBinary(kind);
  }

  function list(): AgentManageRow[] {
    const rows: AgentManageRow[] = [];
    for (const kind of ['pi', 'codex', 'dsh', 'claude'] as const) {
      const binary = effectiveBinary(kind);
      const available = binary.length > 0;
      const userEnabled = config[kind]?.enabled;
      const enabled = userEnabled ?? true;
      const running = kind === 'pi' ? (options.isPiRunning?.() ?? false) : false;
      rows.push({
        kind,
        available,
        enabled,
        running,
        binary: available ? binary : null,
        version: available
          ? kind === 'pi'
            ? piVersionFromRuntime(binary)
            : versionFromBinary(binary)
          : null,
        lifecycle:
          kind === 'pi'
            ? '常驻 RPC 子进程：重启立即生效'
            : kind === 'codex'
              ? '按次 exec：无常驻进程，仅可用性'
              : '按次 headless：无常驻进程，仅可用性',
        config: config[kind] ?? {},
      });
    }
    return rows;
  }

  function configure(kind: AgentKind, patch: AgentConfig): { success: boolean; error?: string } {
    const base = config[kind] ?? {};
    const next: AgentConfig = {};
    // binary: keep the existing override unless patched; empty string clears it
    if (patch.binary !== undefined) {
      if (patch.binary.length > 0) {
        next.binary = patch.binary;
      }
    } else if (base.binary !== undefined) {
      next.binary = base.binary;
    }
    // enabled: keep the existing value unless patched
    if (patch.enabled !== undefined) {
      next.enabled = patch.enabled;
    } else if (base.enabled !== undefined) {
      next.enabled = base.enabled;
    }
    // Rebuild the map without dynamic deletes (lint-safe, exactOptional-safe).
    const rebuilt: Record<string, AgentConfig> = {};
    for (const key of Object.keys(config)) {
      if (key === kind) {
        continue;
      }
      const entry = config[key];
      if (entry !== undefined) {
        rebuilt[key] = entry;
      }
    }
    if (next.binary !== undefined || next.enabled !== undefined) {
      rebuilt[kind] = next;
    }
    config = rebuilt;
    saveConfig(config);
    return { success: true };
  }

  async function restartPi(): Promise<{ success: boolean; error?: string }> {
    if (options.restartPi === undefined) {
      return { success: false, error: 'pi bridge unavailable in this mode' };
    }
    return options.restartPi();
  }

  // ---- one-click install (predefined command templates only) ----
  // The install command is a fixed template per kind — never user input —
  // so the panel can install agents without arbitrary command execution.
  const INSTALL_PLANS: Partial<Record<AgentKind, { command: string[]; label: string }>> = {
    codex: { command: ['npm', 'install', '-g', '@openai/codex'], label: 'npm @openai/codex' },
    claude: { command: ['npm', 'install', '-g', '@anthropic-ai/claude-code'], label: 'npm @anthropic-ai/claude-code' },
    dsh: { command: ['npm', 'install', '-g', '@deepseek-ai/dsh'], label: 'npm @deepseek-ai/dsh' },
  };
  const installState: Partial<Record<AgentKind, { output: string; running: boolean; exit: number | null }>> = {};

  function installPlan(kind: AgentKind): { command: string[]; label: string } | null {
    return INSTALL_PLANS[kind] ?? null;
  }

  async function install(kind: AgentKind): Promise<{ success: boolean; error?: string }> {
    const plan = installPlan(kind);
    if (plan === null) {
      return { success: false, error: `no install plan for ${kind}` };
    }
    if (installState[kind]?.running === true) {
      return { success: false, error: `${kind} install already running` };
    }
    const state = { output: '', running: true, exit: null as number | null };
    installState[kind] = state;
    const { spawn } = await import('node:child_process');
    const child = spawn(plan.command[0] ?? 'npm', plan.command.slice(1), {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const collect = (chunk: Buffer): void => {
      state.output = (state.output + chunk.toString('utf8')).slice(-16 * 1024);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('error', (error) => {
      state.output += `\nspawn error: ${error.message}`;
      state.running = false;
      state.exit = -1;
    });
    child.on('exit', (code) => {
      state.running = false;
      state.exit = code;
    });
    return { success: true };
  }

  function installStatus(kind: AgentKind): { plan: { command: string[]; label: string } | null; running: boolean; exit: number | null; output: string } {
    const state = installState[kind];
    return {
      plan: installPlan(kind),
      running: state?.running === true,
      exit: state?.exit ?? null,
      output: state?.output ?? '',
    };
  }

  return { list, configure, restartPi, installPlan, install, installStatus };
}

export type AgentsManager = ReturnType<typeof createAgentsManager>;
