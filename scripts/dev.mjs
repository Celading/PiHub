// Parallel dev runner: starts the Node backend and the Vite dev server.
// Node 23 `util.styleText` is used for colored output.
import { spawn } from 'node:child_process';

const prefix = (name: string, color: string, data: Buffer | string): void => {
  const lines = String(data).replace(/\n$/, '').split('\n');
  for (const line of lines) {
    if (line.length > 0) {
      // eslint-disable-next-line no-console
      console.log(`\x1b[${color}m[${name}]\x1b[0m ${line}`);
    }
  }
};

const run = (name: string, color: string, cmd: string, args: string[]): void => {
  const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout?.on('data', (d: Buffer) => prefix(name, color, d));
  child.stderr?.on('data', (d: Buffer) => prefix(name, color, d));
  child.on('exit', (code) => {
    // eslint-disable-next-line no-console
    console.log(`[${name}] exited with code ${String(code)}`);
    process.exit(code ?? 1);
  });
};

const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';

run('server', '34', npmCmd, ['run', 'dev:server']);
run('web', '36', npmCmd, ['run', 'dev:web']);
