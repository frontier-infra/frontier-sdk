import { spawn } from 'node:child_process';
import process from 'node:process';

const runner = process.env.npm_execpath || 'npm';
const shell = process.platform === 'win32';

const children = [
  spawn(runner, ['run', 'server'], { stdio: 'inherit', shell }),
  spawn(runner, ['run', 'client'], { stdio: 'inherit', shell }),
];

function shutdown(signal) {
  for (const child of children) child.kill(signal);
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    shutdown(signal);
    process.exit(signal === 'SIGINT' ? 130 : 143);
  });
}

for (const child of children) {
  child.on('exit', (code, signal) => {
    shutdown(signal || 'SIGTERM');
    process.exit(code ?? 1);
  });
}
