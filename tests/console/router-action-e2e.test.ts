import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { openTaskRuntime } from '../../src/core/task-runtime.ts';
import { parseGraphDefinition, type ModuleRule } from '../../src/core/interface-spec.ts';
import { openaiServer } from '../fixtures/openai-server.ts';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const action of cleanup.splice(0).reverse()) await action(); });

/** Real command/agent outputs reach an explicit router, then only the chosen agent executes. */
async function fixture(options: { command?: string[]; value?: unknown; rules?: ModuleRule[]; strictProtocol?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'graph-native-router-e2e-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const provider = await openaiServer([
    ...(!options.command ? [
      { tools: [{ id: 'review', name: 'submit', arguments: JSON.stringify({ outputs: { result: { enable: true, value: options.value ?? { passed: false, reason: 'Revise the label' } } } }) }] },
      { text: 'Reviewer finished' },
    ] : []),
    { text: 'Chosen branch finished' },
  ]);
  cleanup.push(() => provider.close());
  const runtime = await openTaskRuntime({ stateDir: join(root, 'state'), projects: [{ id: 'p', root }],
    limits: { defaultBudgetTokens: 20_000_000 },
    models: { entries: [{ id: 'local', provider: provider.model.provider, grade: 'medium', api: 'openai-completions', baseUrl: provider.model.baseUrl,
      contextWindow: 32000, maxTokens: 256 }], apiKey: 'local-only', modelRuntime: provider.runtime },
  });
  cleanup.push(() => runtime.close());
  runtime.catalog.publishDefinition('worker', { recommendedGrade: 'medium' }, 'worker');
  const { taskId } = await runtime.user.begin({ projectId: 'p', request: 'Route explicitly', requestId: 'begin' });
  const main = runtime.supervisor(taskId); const data = { protocol: 'data' };
  const branch = (task: string) => ({ recipe: 'worker@1', model: 'local', task, inputs: { job: data }, outputs: {}, submission: {} });
  const definition = parseGraphDefinition({ schemaVersion: 2, name: 'Explicit route', protocols: { data: { type: 'object', ...(options.strictProtocol ? { required: ['passed'], properties: { passed: { type: 'boolean' } } } : {}) } },
    nodes: { ship: branch('SHIP_BRANCH'), fix: branch('FIX_BRANCH'), ...(!options.command ? {
      review: { ...branch('Submit the review verdict'), outputs: { result: data }, submission: { required: ['result'] } },
    } : {}) },
    modules: { route: { type: 'router', trigger: 'each', inputs: { review: data }, outputs: { approved: data, rework: data },
      rules: options.rules ?? [{ when: 'review.passed == true', emit: { approved: '$review' } }, { when: 'review.passed == false', emit: { rework: '$review' } }] },
      ...(options.command ? { check: { type: 'operation', trigger: 'each', inputs: { job: data }, outputs: { result: data },
        operation: { action: 'workspace.command', version: 1, command: 'node', args: options.command, output: 'result' } } } : {}),
    }, edges: { source: { from: options.command ? 'check.result' : 'review.result', to: 'route.review', enabled: true },
      approved: { from: 'route.approved', to: 'ship.job', enabled: true }, rework: { from: 'route.rework', to: 'fix.job', enabled: true } },
  });
  const { graphId } = await main.graphCreate({ definition }) as { graphId: string };
  return { runtime, main, graphId, provider, async run() {
    await main.graphSend({ graphId, nodeId: options.command ? 'check' : 'review', input: 'job', value: {} });
    await runtime.host.drive();
  }, async route() { return main.graphInspect({ graphId, query: 'module', id: 'route' }); } };
}

function requestText(body: unknown) {
  const request = body as { messages: { content: string | { text?: string }[] }[] };
  return request.messages.map(({ content }) => typeof content === 'string'
    ? content : content.map(part => part.text ?? '').join('\n')).join('\n');
}

test('a real successful command result selects only the approved branch', async () => {
  const graph = await fixture({ command: ['--version'] }); await graph.run();
  expect(graph.runtime.nodeRun(graph.graphId, 'ship').node.status).toBe('succeeded');
  expect(graph.runtime.nodeRun(graph.graphId, 'fix').operations).toHaveLength(0);
  expect(graph.provider.requests).toHaveLength(1);
  expect(requestText(graph.provider.requests[0])).toContain('SHIP_BRANCH');
  const operations = await graph.main.graphInspect({ graphId: graph.graphId, query: 'operations' });
  expect(operations).toMatchObject([{ state: 'settled', result: { outputs: { result: { passed: true, code: 0 } } } }]);
});

test('a completed reviewer submits a failing business verdict and its reason reaches the rework branch', async () => {
  const graph = await fixture(); await graph.run();
  expect(graph.runtime.nodeRun(graph.graphId, 'review').node.status).toBe('succeeded');
  expect(graph.runtime.nodeRun(graph.graphId, 'fix').node.status).toBe('succeeded');
  expect(graph.runtime.nodeRun(graph.graphId, 'ship').operations).toHaveLength(0);
  expect(graph.provider.requests).toHaveLength(3);
  expect(requestText(graph.provider.requests[2])).toContain('Revise the label');
  expect(requestText(graph.provider.requests[2])).toContain('FIX_BRANCH');
});

test('a real command with a nonzero exit routes its failed result without failing the router evaluation', async () => {
  const graph = await fixture({ command: ['--test', 'missing.test.js'] }); await graph.run();
  expect(graph.runtime.nodeRun(graph.graphId, 'fix').node.status).toBe('succeeded');
  expect(graph.runtime.nodeRun(graph.graphId, 'ship').operations).toHaveLength(0);
  const operations = await graph.main.graphInspect({ graphId: graph.graphId, query: 'operations' });
  expect(operations).toMatchObject([{ state: 'settled', result: { outputs: { result: { passed: false, code: 1 } } } }]);
  expect(requestText(graph.provider.requests[0])).toContain('"passed":false');
});

test('a valid input that matches no explicit rule is held without inventing a branch', async () => {
  const graph = await fixture({ value: { passed: null, reason: 'Decision pending' } }); await graph.run();
  expect(graph.runtime.nodeRun(graph.graphId, 'review').node.status).toBe('succeeded');
  expect(graph.provider.requests).toHaveLength(2);
  expect(graph.runtime.nodeRun(graph.graphId, 'ship').operations).toHaveLength(0);
  expect(graph.runtime.nodeRun(graph.graphId, 'fix').operations).toHaveLength(0);
  expect(await graph.route()).toMatchObject({ inputs: [{ name: 'review', missing: false, value: { passed: null } }], transitions: [{ outputs: {} }] });
});

test('an input protocol requiring the verdict refuses a missing field before judgment or branch activation', async () => {
  const graph = await fixture({ strictProtocol: true });
  await expect(graph.main.graphSend({ graphId: graph.graphId, nodeId: 'route', input: 'review', value: { reason: 'Verdict missing' } }))
    .rejects.toMatchObject({ code: 'invalid_input' });
  expect(graph.provider.requests).toHaveLength(0);
  expect(graph.runtime.nodeRun(graph.graphId, 'ship').operations).toHaveLength(0);
  expect(graph.runtime.nodeRun(graph.graphId, 'fix').operations).toHaveLength(0);
  expect(await graph.route()).toMatchObject({ inputs: [{ name: 'review', missing: true }], transitions: [] });
});

test('an output not declared by the router is refused atomically before it can select any branch', async () => {
  const graph = await fixture();
  await expect(graph.main.graphPatch({ graphId: graph.graphId, baseRevision: 1, changes: { reason: 'Invalid branch', patch: {
    modules: { route: { rules: [{ when: 'review.passed == true', emit: { maybe: '$review' } }] } },
  } } })).rejects.toMatchObject({ code: 'invalid_definition' });
  expect(await graph.main.graphInspect({ graphId: graph.graphId })).toMatchObject({ revision: 1 });
  expect(graph.provider.requests).toHaveLength(0);
  expect(graph.runtime.nodeRun(graph.graphId, 'ship').operations).toHaveLength(0);
  expect(graph.runtime.nodeRun(graph.graphId, 'fix').operations).toHaveLength(0);
});
