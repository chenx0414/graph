import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { openTaskRuntime } from '../../src/core/task-runtime.ts';
import { git } from '../../src/git/git.ts';
import { fullAccessPolicy } from '../../src/core/access-policy.ts';
import { parseGraphDefinition } from '../../src/core/interface-spec.ts';

// A declared acceptance check is frozen even before it has produced evidence.
// Otherwise a main agent could replace the required test with a version probe.
for (const ran of [false, true]) {
  test(`native acceptance check inputs remain frozen ${ran ? 'after a real host check' : 'before the first check'}`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'graph-check-input-'));
    const project = join(root, 'project'); await mkdir(project);
    git(project, ['init', '-b', 'main']);
    await writeFile(join(project, 'README.md'), 'check fixture\n');
    git(project, ['add', '.']); git(project, ['commit', '-m', 'initial']);
    const runtime = await openTaskRuntime({ stateDir: join(root, 'state'), projects: [{ id: 'p', root: project }], access: () => fullAccessPolicy() });
    try {
      const parent = await runtime.user.begin({ projectId: 'p', request: 'Freeze the required check', requestId: 'begin' });
      const main = runtime.supervisor(parent.taskId);
      const definition = parseGraphDefinition({ schemaVersion: 2, name: 'Required check', protocols: { data: { type: 'object' } }, nodes: {},
        modules: { check: { type: 'operation', trigger: 'each', inputs: { job: { protocol: 'data' } }, outputs: { result: { protocol: 'data' } },
          operation: { action: 'workspace.command', version: 1, command: 'node', args: ['-e', 'if (2 + 2 !== 4) process.exit(1)'], output: 'result', sandbox: false } } },
        edges: {}, acceptance: [{ id: 'suite-runs', description: 'Required assertion passes', kind: 'check', module: 'check' }] });
      const { graphId } = await main.graphCreate({ definition }) as { graphId: string };
      if (ran) {
        await main.graphSend({ graphId, nodeId: 'check', input: 'job', value: {} });
        await runtime.host.drive();
        const acceptance = await main.graphInspect({ graphId, query: 'acceptance' }) as { ready: boolean; items: { status: string }[] };
        expect(acceptance.items).toMatchObject([{ status: 'passed' }]);
        expect(acceptance.ready).toBe(true);
      }
      await expect(main.graphPatch({ graphId, baseRevision: 1, changes: {
        reason: 'Replace the required assertion with a version probe', patch: { modules: { check: { operation: { args: ['--version'] } } } },
      } })).rejects.toMatchObject({ code: 'invalid_input', message: expect.stringContaining('acceptance check') });
      const revision = await main.graphInspect({ graphId, query: 'revision' }) as typeof definition;
      await expect(main.graphInspect({ graphId })).resolves.toMatchObject({ revision: 1 });
      expect(revision.modules.check!.operation!.args).toEqual(['-e', 'if (2 + 2 !== 4) process.exit(1)']);
      await expect(main.graphPatch({ graphId, baseRevision: 1, changes: { reason: 'Rename the graph without weakening its check', patch: { name: 'Renamed check' } } }))
        .resolves.toMatchObject({ revision: 2 });
    } finally { await runtime.close(); await rm(root, { recursive: true, force: true }); }
  });
}
