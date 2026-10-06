import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';

const running = (pid: number) => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

test.each(['owner-dies', 'explicit-abort', 'timeout'])('a production command stops after %s', async mode => {
  const dir = await mkdtemp(join(tmpdir(), 'host-command-owner-'));
  const command = join(dir, 'hold.cjs');
  await writeFile(command, "const fs=require('fs');fs.writeFileSync('command.pid',String(process.pid));let n=0;setInterval(()=>fs.writeFileSync('heartbeat',String(++n)),20);");
  const runner = new URL('../../src/runtime/host-command.ts', import.meta.url).href;
  const parentEntry = join(dir, 'owner.mjs');
  await writeFile(parentEntry, `import {runHostCommand} from ${JSON.stringify(runner)};import{existsSync,writeFileSync}from'node:fs';const c=new AbortController();const timer=setInterval(()=>{if(existsSync(${JSON.stringify(join(dir, 'abort.flag'))}))c.abort()},20);try{const result=await runHostCommand({cwd:${JSON.stringify(dir)},executable:process.execPath,args:[${JSON.stringify(command)}],env:{},${mode === 'timeout' ? 'timeoutMs:1000,' : ''}signal:c.signal});writeFileSync(${JSON.stringify(join(dir, 'result.json'))},JSON.stringify(result))}finally{clearInterval(timer)}`);
  const parent = spawn(process.execPath, [parentEntry], { stdio: 'ignore', env: {} });
  const closed = once(parent, 'close');
  let pid: number | undefined;
  try {
    await expect.poll(async () => {
      const value = await readFile(join(dir, 'command.pid'), 'utf8').catch(() => '');
      return /^\d+$/.test(value) ? Number(value) : 0;
    }, { timeout: 5000 }).toBeGreaterThan(0);
    pid = Number(await readFile(join(dir, 'command.pid'), 'utf8'));
    expect(running(pid)).toBe(true);
    if (mode === 'owner-dies') parent.kill('SIGKILL');
    else if (mode === 'explicit-abort') await writeFile(join(dir, 'abort.flag'), 'abort');
    await closed;
    await expect.poll(() => running(pid!), { timeout: 5000 }).toBe(false);
    if (mode !== 'owner-dies') {
      const result = JSON.parse(await readFile(join(dir, 'result.json'), 'utf8')) as { code: number | null; stderr: string };
      expect(result.code).toBeNull();
      if (mode === 'timeout') expect(result.stderr).toContain('exceeded the 1000ms timeout');
    }
  } finally {
    if (parent.exitCode === null && parent.signalCode === null) parent.kill('SIGKILL');
    await closed;
    // Only this fixture's still-running command group may be cleaned up after a red run.
    if (pid && running(pid)) {
      try {
        const args = execFileSync('ps', ['-p', String(pid), '-o', 'args='], { encoding: 'utf8' });
        if (args.includes(command)) process.kill(-pid, 'SIGKILL');
      } catch { /* already exited */ }
    }
    await rm(dir, { recursive: true, force: true });
  }
}, 15000);
