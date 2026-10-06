import { modelFor } from '../../src/runtime/kernel-graph-lane.ts';
import { kernelProviderGate } from '../../src/runtime/kernel-provider-gate.ts';
import type { ModelEntry } from '../../src/catalog/models.ts';
import { describe, expect, test } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach } from 'vitest';
import { Catalog } from '../../src/catalog/catalog.ts';
import { TaskStore } from '../../src/core/store.ts';
import { KernelStore } from '../../src/core/kernel-store.ts';
import { parseGraphDefinition } from '../../src/core/interface-spec.ts';
import { openAgentContextLibrary } from '../../src/runtime/agent-context.ts';
import { nodeSessionRequest } from '../../src/runtime/kernel-node-host.ts';

/**
 * Issue #1 §13.8 + §10 — the v2-native session assembly for one graph node.
 *
 * The old path assembles a node's Pi session from an "operation": `operation.id`,
 * `operation.grants`, `spec.action`, activations. The v2 kernel has none of those (§3/§5
 * replace them with delivery and execution), so the session is assembled from what a v2
 * node actually has: its `recipe` (the definition version, §5) resolved through the
 * catalog, on the project workspace.
 *
 * Failure modes first (R24):
 *   N1  the node's session request is built from its recipe, not from any operation
 *   N2  two nodes with different recipes get different prompts (the recipe is the identity)
 *   N3  a node whose recipe names an unknown definition fails loudly, not silently
 *   N4  the per-node state directory is the node's own, so two nodes never share a session
 *   N5  the request carries the graph and node identity the host binds to
 */

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const action of cleanup.reverse()) await action(); cleanup.length = 0; });

async function writeCapability(root: string, id: string, manifest: Record<string, unknown>, files: Record<string, string> = {}) {
  const directory = join(root, id);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'capability.json'), JSON.stringify({ id, ...manifest }, null, 2));
  for (const [name, body] of Object.entries(files)) {
    const target = join(directory, name);
    await mkdir(join(target, '..'), { recursive: true });
    await writeFile(target, body);
  }
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'kernel-node-host-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const capabilityRoot = join(root, 'capabilities');
  await writeCapability(capabilityRoot, 'research', { kind: 'skill', version: '1.0.0', name: 'Research' }, { 'SKILL.md': '# Research\n' });
  const recipesPath = join(root, 'agent-combinations.json');
  const store = new TaskStore(join(root, 'tasks.sqlite'));
  cleanup.push(() => store.close());
  const catalog = new Catalog(store, { capabilityRoot, recipesPath });
  await catalog.refresh();
  // Two recipes with different inline prompts: the recipe is the session identity.
  await catalog.saveAgentCombination({ id: 'alpha', name: 'Alpha', description: 'a', recommendedGrade: 'medium', review: false, tags: [], resources: [], systemPrompt: 'You are ALPHA.' });
  await catalog.saveAgentCombination({ id: 'beta', name: 'Beta', description: 'b', recommendedGrade: 'medium', review: true, tags: [], resources: [], systemPrompt: 'You are BETA.' });

  const kernel = new KernelStore(store);
  store.db.exec(`INSERT INTO projects(id,root,grants) VALUES('p','${root}','[]');`);
  store.db.prepare('INSERT INTO tasks(id,project_id,request,requirement_version,latest_proposal,phase,paused,created_seq) VALUES(?,?,?,1,0,?,0,1)').run('g1', 'p', 'r', 'running');
  const definition = parseGraphDefinition({
    schemaVersion: 2, name: 'g',
    protocols: { ping: { type: 'object', required: ['n'], properties: { n: { type: 'number' } } } },
    nodes: {
      a: { recipe: 'alpha@1', task: 'do alpha', inputs: {}, outputs: { out: { protocol: 'ping' } }, submission: { required: ['out'] } },
      b: { recipe: 'beta@1', task: 'do beta', inputs: {}, outputs: { out: { protocol: 'ping' } }, submission: { required: ['out'] } },
    },
    modules: {}, edges: {},
  });
  const rev = kernel.publishRevision('g1', { definition, reason: 'create' });
  return { root, catalog, kernel, revisionVersion: rev.version };
}

/** Insert the task row a second graph needs; kept beside the fixture for locality. */
function store2(kernel: KernelStore, taskId: string) {
  kernel.db.prepare('INSERT INTO tasks(id,project_id,request,requirement_version,latest_proposal,phase,paused,created_seq) VALUES(?,?,?,1,0,?,0,2)').run(taskId, 'p', 'r', 'running');
}

describe('nodeSessionRequest — the v2-native session for one graph node (§13.8)', () => {
  test('N1: the request is built from the node recipe, carrying the graph and node identity', async () => {
    const { root, catalog, kernel, revisionVersion } = await fixture();
    const request = await nodeSessionRequest({ kernel, catalog, graphId: 'g1', nodeId: 'a', revisionVersion, workspace: root, instancesDir: join(root, 'instances') });

    expect(request.binding).toEqual({ instanceId: expect.any(String), nodeId: 'a', definitionVersion: 'alpha@1' });
    expect(request.systemPrompt).toContain('You are ALPHA.');
  });

  test('N2: two nodes with different recipes get different prompts — the recipe is the identity', async () => {
    const { root, catalog, kernel, revisionVersion } = await fixture();
    const library = openAgentContextLibrary(join(root, 'prompts')); await library.ensure();
    await writeFile(join(library.root, 'rules/worker.md'), 'WORKER POLICY: implement assigned work.');
    await writeFile(join(library.root, 'rules/reviewer.md'), 'REVIEWER POLICY: independently inspect the exact supplied version.');
    const a = await nodeSessionRequest({ kernel, catalog, graphId: 'g1', nodeId: 'a', revisionVersion, workspace: root, instancesDir: join(root, 'instances'), library });
    const b = await nodeSessionRequest({ kernel, catalog, graphId: 'g1', nodeId: 'b', revisionVersion, workspace: root, instancesDir: join(root, 'instances'), library });

    expect(a.systemPrompt).toContain('WORKER POLICY');
    expect(b.systemPrompt).toContain('REVIEWER POLICY');
    expect(b.systemPrompt).not.toContain('WORKER POLICY');
    expect(b.systemPrompt).not.toContain('Start writing implementation files');
    expect(b.systemPrompt).not.toContain('submit_result');
    expect(a.systemPrompt).toContain('ALPHA');
    expect(a.systemPrompt).not.toContain('BETA');
    expect(b.systemPrompt).toContain('BETA');
    expect(b.systemPrompt).not.toContain('ALPHA');
  });

  test('N3: an unknown recipe fails loudly instead of assembling a nameless session', async () => {
    const { root, catalog, kernel } = await fixture();
    const definition = parseGraphDefinition({
      schemaVersion: 2, name: 'g2',
      protocols: { ping: { type: 'object', required: ['n'], properties: { n: { type: 'number' } } } },
      nodes: { a: { recipe: 'ghost@9', task: 'x', inputs: {}, outputs: { out: { protocol: 'ping' } }, submission: { required: ['out'] } } },
      modules: {}, edges: {},
    });
    store2(kernel, 'g2');
    const rev = kernel.publishRevision('g2', { definition, reason: 'create' });
    await expect(nodeSessionRequest({ kernel, catalog, graphId: 'g2', nodeId: 'a', revisionVersion: rev.version, workspace: root, instancesDir: join(root, 'instances') }))
      .rejects.toThrow(/ghost@9|catalog does not hold/i);
  });

  test('N4: the state directory is the node own, so two nodes never share a session', async () => {
    const { root, catalog, kernel, revisionVersion } = await fixture();
    const a = await nodeSessionRequest({ kernel, catalog, graphId: 'g1', nodeId: 'a', revisionVersion, workspace: root, instancesDir: join(root, 'instances') });
    const b = await nodeSessionRequest({ kernel, catalog, graphId: 'g1', nodeId: 'b', revisionVersion, workspace: root, instancesDir: join(root, 'instances') });
    expect(a.stateDir).not.toBe(b.stateDir);
    expect(a.stateDir).toContain('a');
    expect(b.stateDir).toContain('b');
  });

  test('N5: the request exposes the prompt and digests the resident host needs', async () => {
    const { root, catalog, kernel, revisionVersion } = await fixture();
    const request = await nodeSessionRequest({ kernel, catalog, graphId: 'g1', nodeId: 'a', revisionVersion, workspace: root, instancesDir: join(root, 'instances') });
    expect(request.bundleDigest).toBeTruthy();
    expect(request.toolPolicyDigest).toBeTruthy();
    expect(request.runtimePolicyDigest).toBeTruthy();
    expect(Array.isArray(request.allowedToolNames)).toBe(true);
  });
});


test('review model selection excludes recorded implementer identities through routing and rework cycles', async () => {
  const { root, catalog, kernel } = await fixture();
  const definition = kernel.latestRevision('g1')!.definition;
  definition.nodes.a!.inputs = { back: { protocol: 'ping' } };
  definition.nodes.b!.inputs = { review: { protocol: 'ping' } };
  definition.modules.route = { type: 'router', trigger: 'each', inputs: { in: { protocol: 'ping' } },
    outputs: { out: { protocol: 'ping' } }, rules: [{ when: 'true', emit: {} }] };
  definition.edges = { work: { from: 'a.out', to: 'route.in', enabled: true },
    review: { from: 'route.out', to: 'b.review', enabled: true }, rework: { from: 'b.out', to: 'a.back', enabled: true } };
  const revision = kernel.publishRevision('g1', { definition, reason: 'review' });
  kernel.admitNode('g1', revision.version, 'a', { instanceId: 'implementer' });
  kernel.startExecution('g1', { executionId: 'work', nodeId: 'a', revisionVersion: revision.version });
  const model = (id: string, modelId: string): ModelEntry => ({ id, modelId, provider: 'fixture',
    grade: 'medium', api: 'openai-completions', baseUrl: 'http://127.0.0.1:1', contextWindow: 32000, maxTokens: 256 });
  const entries = [model('implementation', 'same-upstream'), model('alias', 'same-upstream'), model('independent', 'different-upstream')];
  kernel.budgetState('g1', 'a', { budget: 0, unlimited: true });
  const gate = kernelProviderGate(kernel, 'g1', 'a', undefined, entries[0]);
  gate.dispatch('actual-send', 100, () => undefined);
  gate.settle('actual-send', { input: 10, output: 10, cacheRead: 0, cacheWrite: 0 });
  // Editing the current catalog cannot erase the identity which did the work.
  entries[0]!.modelId = 'edited-upstream';
  const options = { kernel, catalog, directory: () => entries, credentialFor: () => undefined,
    instancesDir: join(root, 'instances'), stateDir: root, workspaceFor: () => root };
  const context = { graphId: 'g1', nodeId: 'b', revisionVersion: revision.version };
  expect(modelFor(options, 'beta@1', context)?.id).toBe('independent');
  entries.push(model('preferred', 'unused-upstream'));
  const requested = kernel.latestRevision('g1')!.definition;
  requested.nodes.b!.model = 'preferred';
  const updated = kernel.publishRevision('g1', { definition: requested, reason: 'request a model' });
  expect(modelFor(options, 'beta@1', { ...context, revisionVersion: updated.version })?.id).toBe('preferred');
  expect(modelFor(options, 'beta@1', context)?.id).toBe('independent');
  requested.nodes.b!.model = 'alias';
  const disallowed = kernel.publishRevision('g1', { definition: requested, reason: 'request cannot bypass independence' });
  expect(modelFor(options, 'beta@1', { ...context, revisionVersion: disallowed.version })?.id).toBe('independent');
  entries.pop();
  entries.pop();
  expect(modelFor(options, 'beta@1', context)).toBeUndefined();
});
