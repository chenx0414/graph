import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';

/**
 * HB-338 candidate — a driven retry that awaits only settled work starves the event loop.
 *
 * While a graph keeps re-proposing an input it cannot dispatch yet (a legal pre-send wait), timers
 * must still fire and the process must still be able to stop; once the wait clears, the same delivery
 * must be consumed — the input is never dropped and the module is never left paused.
 *
 * The scenario runs in a child process, and a hard kill is asserted to be a failure: a starved event
 * loop starves the timer a test would use to time out, so the parent supervises with a kill instead
 * of trusting one.
 */
const runChild = (dir: string, mode: 'resume' | 'stop') => new Promise<{ code: number | null; signal: string | null; stdout: string; stderr: string }>((resolve, reject) => {
  const child = execFile('node_modules/.bin/node',
    ['tests/fixtures/hb338-drive-liveness.ts', join(dir, 'tasks.sqlite'), mode],
    { cwd: process.cwd(), timeout: 8000, killSignal: 'SIGKILL' });
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', chunk => { stdout += String(chunk); });
  child.stderr?.on('data', chunk => { stderr += String(chunk); });
  child.on('error', reject);
  child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
});

test('a graph waiting before dispatch never starves the event loop, and the same delivery continues', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hb338-liveness-'));
  try {
    const resumed = await runChild(dir, 'resume');
    expect(resumed.signal, resumed.stderr).toBeNull();
    expect(resumed.code, resumed.stderr).toBe(0);
    // Timers kept running while the input waited: the line a starved loop never prints.
    expect(resumed.stdout).toMatch(/HEARTBEAT [1-9]/);
    // The same delivery was consumed once, its output landed, and nothing was paused.
    expect(resumed.stdout).toContain('inbox_pending=0 transitions=1 paused=false');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 20000);

test('stopping while a graph waits before dispatch exits cleanly and keeps the delivery pending', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hb338-liveness-stop-'));
  try {
    const stopped = await runChild(dir, 'stop');
    expect(stopped.signal, stopped.stderr).toBeNull();
    expect(stopped.code, stopped.stderr).toBe(0);
    expect(stopped.stdout).toMatch(/HEARTBEAT [1-9]/);
    expect(stopped.stdout).toContain('inbox_pending=1');
    expect(stopped.stdout).toContain('paused=false');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 20000);
