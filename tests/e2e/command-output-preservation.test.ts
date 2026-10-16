import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { openTaskRuntime } from '../../src/core/task-runtime.ts';
import { fullAccessPolicy } from '../../src/core/access-policy.ts';

test('public graph command preserves bytes beyond its inline ceiling and reuses settled files after restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-output-preservation-'));
  const options = { stateDir: join(root, 'state'), projects: [{ id: 'p', root }], access: () => fullAccessPolicy() };
  let runtime = await openTaskRuntime(options);
  try {
    const owner = await runtime.user.begin({ projectId: 'p', request: 'Preserve a large check output', requestId: 'begin' });
    const main = runtime.supervisor(owner.taskId);
    const bytes = 32 * 1024 * 1024 + 123;
    const { graphId } = await main.graphCreate({ definition: {
      schemaVersion: 2, name: 'Output preservation', protocols: { data: { type: 'object' } }, nodes: {},
      modules: { check: { type: 'operation', trigger: 'each', inputs: { job: { protocol: 'data' } }, outputs: { result: { protocol: 'data' } },
        operation: { action: 'workspace.command', version: 1, command: 'node', sandbox: false, output: 'result',
          args: ['-e', `process.stdout.write(Buffer.alloc(${bytes},120));process.stdout.write('FINAL-OUTPUT');process.stderr.write('FINAL-ERROR');`] } } },
      edges: {}, inputs: {}, outputs: {},
    } }) as { graphId: string };
    await main.graphSend({ graphId, nodeId: 'check', input: 'job', value: {} });
    await runtime.host.drive();
    const inspect = () => runtime.supervisor(owner.taskId).graphInspect({ graphId, query: 'operations' });
    type FileInfo = { path: string; bytes: number; digest: string };
    type Operation = { state: string; result: { outputs: { result: { passed: boolean; stdout: string; outputFiles: { stdout: FileInfo; stderr: FileInfo } } } } };
    const operations = await inspect() as Operation[];
    expect(operations).toHaveLength(1);
    expect(operations[0]!.state).toBe('settled');
    const output = operations[0]!.result.outputs.result;
    expect(output.passed).toBe(true);
    expect(output.stdout.length).toBeLessThanOrEqual(32_768);
    expect(output.outputFiles).toBeDefined();
    const stdout = await readFile(output.outputFiles.stdout.path);
    expect(stdout.length).toBe(bytes + 'FINAL-OUTPUT'.length);
    expect(stdout.subarray(-12).toString()).toBe('FINAL-OUTPUT');
    expect(output.outputFiles.stdout).toMatchObject({ bytes: stdout.length, digest: createHash('sha256').update(stdout).digest('hex') });
    expect(await readFile(output.outputFiles.stderr.path, 'utf8')).toBe('FINAL-ERROR');
    await runtime.close();
    runtime = await openTaskRuntime(options);
    await runtime.host.drive();
    expect(await inspect()).toEqual(operations);
    const restored = await readFile(output.outputFiles.stdout.path);
    expect(restored.length).toBe(stdout.length);
    expect(createHash('sha256').update(restored).digest('hex')).toBe(output.outputFiles.stdout.digest);
  } finally { await runtime.close(); await rm(root, { recursive: true, force: true }); }
}, 60_000);
