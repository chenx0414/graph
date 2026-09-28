import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { openGraphServer } from '../../src/server/host.ts';
import { openAgentContextLibrary } from '../../src/runtime/agent-context.ts';
import { openaiServer } from '../fixtures/openai-server.ts';

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const close of cleanup.reverse()) await close(); cleanup.length = 0; });

const identityPath = join(process.env.HOME ?? '', '.graph', 'capabilities', 'agent-md', 'matt-pocock-merge');

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'graph-matt-merge-recipe-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const capabilityRoot = join(root, 'capabilities');
  const workspace = join(root, 'workspace');
  await mkdir(capabilityRoot, { recursive: true });
  await mkdir(workspace, { recursive: true });
  const library = openAgentContextLibrary(join(root, 'prompts'));
  await library.ensure();
  return { root, capabilityRoot, workspace, library };
}

/** The identity the recipe binds, copied in so this test never depends on the host's library. */
async function installMergeIdentity(capabilityRoot: string) {
  const target = join(capabilityRoot, 'matt-pocock-merge');
  await mkdir(target, { recursive: true });
  await writeFile(join(target, 'capability.json'), JSON.stringify({
    id: 'matt-pocock-merge', kind: 'prompt', role: 'agent', version: '1.0.0', name: 'merge',
    description: 'Matt 工程流里的合流 Agent。', source: 'local:docs/agents/matt-flow.md',
  }));
  await writeFile(join(target, 'agent.md'), await readFile(join(identityPath, 'agent.md'), 'utf8'));
}

test('the merge recipe compiles, and its identity really becomes the system prompt of a dispatched node', async () => {
  const { root, capabilityRoot, workspace, library } = await fixture();
  await installMergeIdentity(capabilityRoot);
  const provider = await openaiServer([{ text: 'done' }]);
  cleanup.push(() => provider.close());

  const recipesPath = join(root, 'agent-combinations.json');
  const server = await openGraphServer({
    stateDir: join(root, 'state'), agentContext: library, catalog: { capabilityRoot, recipesPath },
    projects: [{ id: 'project', root: workspace }],
    models: {
      entries: [{ id: 'local', provider: 'graph-openai', grade: 'high', api: 'openai-completions', baseUrl: provider.model.baseUrl, contextWindow: 32_000, maxTokens: 256 }],
      credentialFor: () => ({ credentialId: 'local', apiKey: 'scripted-local-key' }), modelRuntime: provider.runtime,
    },
  });
  cleanup.push(() => server.close());

  // The recipe is the same shape as the other Matt recipes: identity + skill + extension.
  await server.runtime.catalog.saveAgentCombination({
    id: 'matt-merge',
    name: 'Frank_merger',
    description: 'Matt 工程流的合流 Agent：两条车道撞在同一处时产出两边都活着的合并结果。',
    recommendedGrade: 'medium',
    review: false,
    tags: ['matt-flow', 'merge'],
    resources: [
      { resourceId: 'matt-pocock-merge', role: 'identity', required: true, version: '1.0.0' },
    ],
  } as unknown as Parameters<typeof server.runtime.catalog.saveAgentCombination>[0]);
  const view = server.runtime.catalog.agentCombinations().find(item => item.id === 'matt-merge');
  expect(view?.status, JSON.stringify(view?.issues)).toBe('valid');

  const published = server.runtime.catalog.compileAgentCombination('matt-merge');
  expect(published.definitionVersion).toBe('matt-merge@1');

  // A node that cites the recipe must receive the merge identity as its system prompt.
  const { taskId } = await server.runtime.user.begin({ projectId: 'project', request: 'merge lanes', requestId: 'begin' });
  await server.runtime.supervisor(taskId).propose({
    requirementVersion: 1,
    summary: 'merge lanes',
    acceptance: [{ id: 'ok', description: 'ok', checkNode: 'check' }],
    nodes: [
      { id: 'merge-lane', kind: 'agent', action: 'work', definitionVersion: 'matt-merge@1', model: 'local' },
      { id: 'check', kind: 'program', action: 'check', dependsOn: ['merge-lane'] },
    ],
  }, 'proposal');
  await server.runtime.user.task(taskId).accept({ proposalVersion: 1, targetBranch: 'main', requestId: 'accept' });
  await server.runtime.host.runReady();

  expect(provider.requests).toHaveLength(1);
  const sent = provider.requests[0] as { messages: { role: string; content: string }[] };
  const system = sent.messages.map(m => m.content ?? '').join('\n');
  // The identity body is what the agent really reads, not a reference to it.
  expect(system).toContain('你是 Matt 工程流里的「合流」Agent');
  // The gate line: the agent must check the precondition before doing any work.
  expect(system).toContain('matt-flow.mjs --stage merge');
  // The rule that keeps a model from inventing a merge travels with the identity.
  expect(system).toContain('丢掉任何一侧的改动都不是合并');
  // It also carries where it may write and what it must report.
  expect(system).toContain('只改冲突列出的文件');
}, 60_000);
