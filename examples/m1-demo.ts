import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { openTaskRuntime } from '../src/core/task-runtime.ts';

// Two real Node processes share one persistent task. No model service is called.
if (process.argv[2] !== '--stage') {
  const root = process.argv[2] ? resolve(process.argv[2]) : await mkdtemp(join(tmpdir(), 'graph-m1-demo-'));
  await mkdir(root, { recursive: true });
  for (const stage of ['implement', 'verify']) {
    const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--stage', stage, root], { stdio: 'inherit' });
    if (child.error) throw child.error;
    if (child.status !== 0) process.exit(child.status ?? 1);
  }
  console.log(`Persistent state and delivery report: ${root}`);
} else {
  const stage = process.argv[3]!;
  const root = process.argv[4]!;
  const workspace = join(root, 'workspace');
  await mkdir(workspace, { recursive: true });
  const artifact = join(workspace, 'search.mjs');
  const runtime = await openTaskRuntime({ stateDir: join(root, 'state'), projects: [{ id: 'demo', root: workspace, grants: ['workspace:write'] }], actions: {
    implement: { kind: 'agent', grant: 'workspace:write', reserveTokens: 100, prepare: async () => async () => {
      await writeFile(artifact, 'export const search = (titles, query) => titles.filter(title => title.toLowerCase().includes(query.toLowerCase()));\n');
      return { outcome: 'completed', output: { artifact }, usage: { input: 40, output: 10, cacheRead: 0, cacheWrite: 0 } };
    } },
    verify: { kind: 'program', prepare: async operation => async () => {
      const { search } = await import(pathToFileURL(artifact).href) as { search: (titles: string[], query: string) => string[] };
      const actual = search(['Graph Runtime', 'Bookmarks', 'Graph Notes'], 'GRAPH');
      if (JSON.stringify(actual) !== JSON.stringify(['Graph Runtime', 'Graph Notes'])) throw new Error('Title search failed');
      if (JSON.stringify(operation.dependencies.implement) !== JSON.stringify({ artifact })) throw new Error('Missing implementation handoff');
      const digest = createHash('sha256').update(await readFile(artifact)).digest('hex');
      return { outcome: 'completed', output: { passed: true, actual }, evidence: [{ acceptanceId: 'title-search', summary: 'Case-insensitive title search returns exactly two matching titles', artifact: { path: artifact, digest } }] };
    } },
  } });
  try {
    const { taskId } = await runtime.user.begin({ projectId: 'demo', request: 'Implement case-insensitive title search', requestId: 'demo-begin' });
    const proposal = await runtime.supervisor(taskId).propose({ requirementVersion: 1, summary: 'Implement and check title search',
      acceptance: [{ id: 'title-search', description: 'Find only the matching titles, ignoring case', checkNode: 'verify' }],
      nodes: [{ id: 'implement', kind: 'agent', action: 'implement', definitionVersion: 'scripted-coder@1', model: 'scripted' }, { id: 'verify', kind: 'program', action: 'verify', dependsOn: ['implement'] }],
    }, 'demo-proposal');
    const task = runtime.user.task(taskId);
    await task.accept({ proposalVersion: proposal.proposalVersion, targetBranch: 'main', requestId: 'demo-accept' });
    const { dispatched } = await runtime.host.runReady();
    const view = await task.view();
    await writeFile(join(root, 'delivery.json'), JSON.stringify(view, null, 2));
    console.log(JSON.stringify({ stage, pid: process.pid, taskId, phase: view.phase, dispatched, instanceId: view.nodes[0]!.instanceId, used: view.nodes[0]!.used, evidence: view.evidence.length }));
    if (stage === 'verify' && view.phase !== 'completed') throw new Error('Delivery did not complete');
  } finally { await runtime.close(); }
}
