import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';

/**
 * HB-338 candidate — a driven retry that awaits only settled work starves the event loop.
 *
 * While a graph keeps re-proposing an input it cannot dispatch yet (a legal pre-send wait), timers
 * must still fire and the process must still be able to stop; once the wait clears, that same
 * delivery must be consumed with its output landed — the input is never dropped and the module is
 * never left paused. Both are exercised with and without a legitimate main node whose action is
 * still waiting, because a real pending promise is what made two narrower fixes look sufficient.
 *
 * The scenario runs in a child process, and a hard kill is asserted to be a failure: a starved event
 * loop starves the timer a test would use to time out, so the parent supervises with a kill instead
 * of trusting one.
 */
const runChild = (dir: string, mode: 'resume' | 'stop', main: 'none' | 'main') => new Promise<{ code: number | null; signal: string | null; stdout: string; stderr: string }>((resolve, reject) => {
  const child = execFile('node_modules/.bin/node',
    ['tests/fixtures/hb338-drive-liveness.ts', join(dir, 'tasks.sqlite'), mode, main],
    { cwd: process.cwd(), timeout: 8000, killSignal: 'SIGKILL' });
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', chunk => { stdout += String(chunk); });
  child.stderr?.on('data', chunk => { stderr += String(chunk); });
  child.on('error', reject);
  child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
});

const cases = [['none', 'without a waiting main'], ['main', 'with a waiting main']] as const;

test.each(cases)('a graph waiting before dispatch never starves the event loop, and the same delivery continues (%s)', async (main) => {
  const dir = await mkdtemp(join(tmpdir(), `hb338-liveness-${main}-`));
  try {
    const resumed = await runChild(dir, 'resume', main);
    expect(resumed.signal, resumed.stderr).toBeNull();
    expect(resumed.code, resumed.stderr).toBe(0);
    // Timers kept running while the input waited: the line a starved loop never prints.
    expect(resumed.stdout).toMatch(/HEARTBEAT [1-9]/);
    if (main === 'main') expect(resumed.stdout).toContain('MAIN_STARTED');
    // The original delivery was consumed and its output landed; nothing was paused.
    expect(resumed.stdout).toContain('inbox_pending=0');
    expect(resumed.stdout).toContain('DELIVERY processed=1');
    expect(resumed.stdout).toContain('"passed":true');
    expect(resumed.stdout).toContain('paused=false');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 30000);

test.each(cases)('stopping while a graph waits before dispatch exits cleanly and keeps the delivery pending (%s)', async (main) => {
  const dir = await mkdtemp(join(tmpdir(), `hb338-liveness-stop-${main}-`));
  try {
    const stopped = await runChild(dir, 'stop', main);
    expect(stopped.signal, stopped.stderr).toBeNull();
    expect(stopped.code, stopped.stderr).toBe(0);
    expect(stopped.stdout).toMatch(/HEARTBEAT [1-9]/);
    expect(stopped.stdout).toContain('inbox_pending=1');
    expect(stopped.stdout).toContain('paused=false');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 30000);
