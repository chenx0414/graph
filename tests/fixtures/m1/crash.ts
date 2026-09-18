import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { openTaskRuntime } from '../../../src/core/task-runtime.ts';
const root = process.argv[2]!;
const stage = process.argv[3]!;
const result = { outcome: 'completed' as const, output: { artifact: join(root, 'artifact.txt') }, usage: { input: 40, output: 10, cacheRead: 0, cacheWrite: 0 } };
process.on('message', () => {});
const runtime = await openTaskRuntime({ stateDir: join(root, 'state'), projects: [{ id: 'project', root }], limits: { defaultBudgetTokens: 20_000_000 }, actions: {
  work: { kind: 'agent', reserveTokens: 100, prepare: async operation => {
    if (operation.attempt === 1) return async () => ({ outcome: 'continue', output: null, usage: { input: 20, output: 10, cacheRead: 0, cacheWrite: 0 } });
    if (stage === 'intent') { process.send?.({ taskId: operation.taskId, operation }); await new Promise(() => {}); }
    return async () => {
      await writeFile(join(root, 'artifact.txt'), 'Verified implementation');
      await writeFile(join(root, 'receipt.json'), JSON.stringify(result));
      process.send?.({ taskId: operation.taskId, operation });
      await new Promise(() => {});
      return result;
    };
  } },
} });
const { taskId } = await runtime.user.begin({ projectId: 'project', request: 'Recover this work', requestId: 'begin' });
const proposal = await runtime.supervisor(taskId).propose({ requirementVersion: 1, summary: 'Recover this work',
  acceptance: [{ id: 'works', description: 'Artifact exists', checkNode: 'check' }],
  nodes: [{ id: 'work', kind: 'agent', action: 'work', model: 'scripted', definitionVersion: 'worker@1' }, { id: 'check', kind: 'program', action: 'check', dependsOn: ['work'] }],
}, 'proposal');
await runtime.user.task(taskId).accept({ proposalVersion: proposal.proposalVersion, targetBranch: 'main', requestId: 'accept' });
await runtime.host.runReady();
await runtime.host.runReady();
