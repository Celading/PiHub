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

const run = (name, color, cmd, args) => {
  const child = spawn(cmd, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    // Polling-based file watching: reliable under sandboxed runtimes where
    // native watchers (fsevents/inotify) are unavailable (vite uses its own
    // config flag; tsx/chokidar honors this env var).
    env: { ...process.env, CHOKIDAR_USEPOLLING: 'true' },
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

run('server', '34', npmCmd, ['run', 'dev:server']);
run('web', '36', npmCmd, ['run', 'dev:web']);
