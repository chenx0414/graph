import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

/** Pinned runtime, prepared by the operator. Evaluations never pull an image or use the network. */
export const MODULE_IMAGE = 'node:24.20.0-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e';
export const MODULE_MEMORY_MB = 256;

function docker(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    child.stdout.on('data', data => { if (stdout.length < 4096) stdout += data; });
    child.stderr.on('data', data => { if (stderr.length < 4096) stderr += data; });
    child.on('error', error => { clearTimeout(timer); resolve({ code: null, stdout, stderr: error.message }); });
    child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

/** Linux cgroups enforce resident memory including Buffers, native allocations and swap. */
export async function runModuleContainer(input: {
  directory: string; payload: string; memoryMb: number; timeoutMs: number; maxOutputBytes: number;
}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  if (!Number.isSafeInteger(input.memoryMb) || input.memoryMb < 64 || input.memoryMb > 16384) {
    throw new Error('Module process memory limit must be between 64 and 16384 MiB');
  }
  const name = `graph-module-${randomUUID()}`;
  let limitError: string | undefined;
  let kill: Promise<unknown> | undefined;
  const terminate = () => { kill ??= docker(['kill', name]); };
  try {
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>(resolve => {
      const child = spawn('docker', ['run', '--name', name, '--pull=never', '--interactive', '--network=none',
        `--memory=${input.memoryMb}m`, `--memory-swap=${input.memoryMb}m`, '--pids-limit=32', '--cpus=1',
        '--cap-drop=ALL', '--security-opt=no-new-privileges', '--read-only', '--user=65534:65534',
        '--tmpfs=/tmp:rw,noexec,nosuid,size=16m', '--mount', `type=bind,src=${input.directory},dst=/graph,readonly`,
        MODULE_IMAGE, 'node', '--permission', '--allow-fs-read=/graph/worker.mjs', '--allow-fs-read=/graph/module.mjs',
        '/graph/worker.mjs', '/graph/module.mjs'], { stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '', stderr = '', bytes = 0;
      const timer = setTimeout(() => { limitError = `module exceeded ${input.timeoutMs}ms timeout`; terminate(); child.kill('SIGKILL'); }, input.timeoutMs);
      const accept = (data: Buffer, output: 'stdout' | 'stderr') => {
        bytes += data.byteLength;
        if (limitError) return;
        if (bytes > input.maxOutputBytes) { limitError = `module output exceeded ${input.maxOutputBytes} bytes`; terminate(); child.kill('SIGKILL'); return; }
        if (output === 'stdout') stdout += data.toString(); else stderr += data.toString();
      };
      child.stdout.on('data', data => accept(data, 'stdout'));
      child.stderr.on('data', data => accept(data, 'stderr'));
      child.stdin.on('error', () => {});
      child.on('error', error => { clearTimeout(timer); resolve({ code: null, stdout, stderr: error.message }); });
      child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr: limitError ?? stderr }); });
      child.stdin.end(input.payload);
    });
    await kill;
    const enforcement = await docker(['inspect', '--format', '{{.State.OOMKilled}}', name]);
    if (enforcement.stdout.trim() === 'true') return { ...result, code: 137, stderr: `module exceeded the ${input.memoryMb} MiB process memory limit` };
    return result;
  } finally { await docker(['rm', '--force', name]); }
}
