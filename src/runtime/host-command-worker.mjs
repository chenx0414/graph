import { spawn } from 'node:child_process';

// The supervisor owns the command group. IPC EOF survives the owner's SIGKILL,
// unlike cleanup callbacks in the owner itself. Install it before accepting work.
let command;
let cancelled = false;
let finished = false;
const cancel = () => {
  if (finished) return;
  cancelled = true;
  if (!command) {
    if (process.connected) process.disconnect();
    return;
  }
  try { process.kill(-command.pid, 'SIGKILL'); }
  catch { try { command.kill('SIGKILL'); } catch { /* already exited */ } }
};
process.on('disconnect', cancel);
process.on('SIGTERM', cancel);
process.on('SIGINT', cancel);
process.stdout.on('error', cancel);
process.stderr.on('error', cancel);

const finish = (code, error) => {
  if (finished) return;
  finished = true;
  const message = { kind: 'result', code, ...(error ? { error: `${error}\n` } : {}) };
  if (process.connected) process.send(message, () => { if (process.connected) process.disconnect(); });
};
process.on('message', message => {
  if (message.kind === 'cancel') { cancel(); return; }
  if (message.kind !== 'start' || command || cancelled) return;
  command = spawn(message.executable, message.args, {
    cwd: message.cwd,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: message.env,
  });
  command.stdout.pipe(process.stdout, { end: false });
  command.stderr.pipe(process.stderr, { end: false });
  command.on('error', error => finish(null, error.message));
  command.on('close', code => finish(code));
});
