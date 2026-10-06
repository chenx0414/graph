import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

// Install EOF handling before accepting a prepared command. Preparation is not
// execution: the owner records durable admission before sending the start message.
let prepared;
let command;
let finished = false;
const finish = (code, error) => {
  if (finished) return;
  finished = true;
  if (prepared?.quiescence) {
    const { path, nonce } = prepared.quiescence;
    try { writeFileSync(path, JSON.stringify({ nonce, quiescent: true }), { mode: 0o600, flag: 'wx' }); }
    catch { /* No durable proof means recovery must retain the resource hold. */ }
  }
  const message = { kind: 'result', code, ...(error ? { error: `${error}\n` } : {}) };
  if (process.connected) process.send(message, () => { if (process.connected) process.disconnect(); });
};
const cancel = () => {
  if (finished) return;
  if (!command) { finish(null); return; }
  try { process.kill(-command.pid, 'SIGKILL'); }
  catch { try { command.kill('SIGKILL'); } catch { /* already exited */ } }
};
process.on('disconnect', cancel);
process.on('SIGTERM', cancel);
process.on('SIGINT', cancel);
process.stdout.on('error', cancel);
process.stderr.on('error', cancel);
process.on('message', message => {
  if (finished) return;
  if (message.kind === 'cancel') { cancel(); return; }
  if (message.kind === 'prepare' && !prepared) {
    prepared = message;
    if (process.connected) process.send({ kind: 'ready' }, error => { if (error) cancel(); });
    else cancel();
    return;
  }
  if (message.kind !== 'start' || !prepared || command) return;
  command = spawn(prepared.executable, prepared.args, {
    cwd: prepared.cwd,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: prepared.env,
  });
  command.stdout.pipe(process.stdout, { end: false });
  command.stderr.pipe(process.stderr, { end: false });
  // Even a command which exits normally must not leave background group members.
  command.on('exit', () => {
    try { process.kill(-command.pid, 'SIGKILL'); } catch { /* the group is gone */ }
  });
  command.on('error', error => finish(null, error.message));
  command.on('close', code => finish(code));
});
