// Parallel dev runner: starts the Node backend and the Vite dev server.
import { spawn } from 'node:child_process';

const prefix = (name, color, data) => {
  const lines = String(data).replace(/\n$/, '').split('\n');
  for (const line of lines) {
    if (line.length > 0) {
      // eslint-disable-next-line no-console
      console.log(`\x1b[${color}m[${name}]\x1b[0m ${line}`);
    }
  }
};

const run = (name, color, cmd, args, extraEnv = {}) => {
  const child = spawn(cmd, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    // Polling-based file watching: reliable under sandboxed runtimes where
    // native watchers (fsevents/inotify) are unavailable (vite uses its own
    // config flag; tsx/chokidar honors this env var).
    env: { ...process.env, CHOKIDAR_USEPOLLING: 'true', ...extraEnv },
  });
  child.stdout?.on('data', (d) => prefix(name, color, d));
  child.stderr?.on('data', (d) => prefix(name, color, d));
  child.on('exit', (code) => {
    // eslint-disable-next-line no-console
    console.log(`[${name}] exited with code ${String(code)}`);
    process.exit(code ?? 1);
  });
};

const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';

// SPRINT-2 regression fix: the dev backend ran in production mode (default
// PIHUB_MODE), so the control-token gate 401'd every write and sensitive
// read from the vite page (no injected token there) — "missing or invalid
// control token" on every action. The dev stack runs as `debug` mode (the
// kMode escape hatch the server documents for tooling): Host / Origin / LAN
// gating stay on, only the per-process token is disabled for the local page.
run('server', '34', npmCmd, ['run', 'dev:server'], {
  PIHUB_MODE: 'debug',
  PIHUB_DEV_NO_TOKEN: '1',
});
run('web', '36', npmCmd, ['run', 'dev:web']);
