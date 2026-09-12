import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { openTaskRuntime } from '../../../src/core/task-runtime.ts';
import { independentReviewNodes } from '../review-gate.ts';

const root = process.argv[2]!;
process.on('message', () => {});
const runtime = await openTaskRuntime({
  stateDir: join(root, 'state'), projects: [{ id: 'project', root }],
  actions: {
    work: { kind: 'agent', reserveTokens: 100, prepare: async operation => async () => {
      await writeFile(join(operation.workspace!, 'feature.txt'), 'done');
      process.send?.({ taskId: operation.taskId, operation });
      await new Promise(() => {});
      return { outcome: 'completed', output: { file: 'feature.txt' }, usage: { input: 20, output: 10, cacheRead: 0, cacheWrite: 0 } };
    } },
  },
});
runtime.catalog.publishDefinition('coder', { recommendedGrade: 'high' }, 'coder');
runtime.catalog.publishDefinition('reviewer', { recommendedGrade: 'high', review: true }, 'reviewer');
const { taskId } = await runtime.user.begin({ projectId: 'project', request: 'Crash after write', requestId: 'begin' });
const proposal = await runtime.supervisor(taskId).propose({
  requirementVersion: 1, summary: 'Crash after write',
  acceptance: [{ id: 'works', description: 'Works', checkNode: 'check' }],
  nodes: [
    { id: 'work', kind: 'agent', action: 'work', definitionVersion: 'coder@1', model: 'scripted' },
    { id: 'check', kind: 'program', action: 'check', dependsOn: ['work'] },
    ...independentReviewNodes('check'),
  ],
}, 'proposal');
await runtime.user.task(taskId).accept({ proposalVersion: proposal.proposalVersion, targetBranch: 'main', requestId: 'accept' });
await runtime.host.runReady();
