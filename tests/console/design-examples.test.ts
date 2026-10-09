// Executable documentation guards the shape main is instructed to copy.
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { parseGraphDefinition, type GraphDefinition } from '../../src/core/interface-spec.ts';
import { openTaskRuntime } from '../../src/core/task-runtime.ts';

function examples(): GraphDefinition[] {
  const document = readFileSync(join(import.meta.dirname, '..', '..', 'docs', 'design-graph-examples.md'), 'utf8');
  return [...document.matchAll(/```json\n([\s\S]*?)```/g)].map(match => parseGraphDefinition(JSON.parse(match[1]!)));
}

test('the design examples are complete native definitions accepted by the public creation interface', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-doc-create-'));
  const runtime = await openTaskRuntime({ stateDir: join(root, 'state'), projects: [{ id: 'p', root }] });
  try {
    const parent = await runtime.user.begin({ projectId: 'p', request: 'Validate the documented definitions', requestId: 'begin' });
    const main = runtime.supervisor(parent.taskId); const definitions = examples();
    expect(definitions.length).toBeGreaterThan(0);
    for (const definition of definitions) {
      const created = await main.graphCreate({ definition }) as { graphId: string };
      const queue = await main.graphInspect({ graphId: created.graphId, query: 'queue' }) as { items: unknown[] };
      expect(queue.items).toEqual([]);
      await expect(main.graphInspect({ graphId: created.graphId, query: 'revision' })).resolves.toMatchObject({ name: definition.name });
    }
  } finally { await runtime.close(); await rm(root, { recursive: true, force: true }); }
});

test('the documented branch and join actually route through the host and retain the once latch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-doc-route-'));
  const runtime = await openTaskRuntime({ stateDir: join(root, 'state'), projects: [{ id: 'p', root }] });
  try {
    const parent = await runtime.user.begin({ projectId: 'p', request: 'Exercise documented routing', requestId: 'begin' });
    const main = runtime.supervisor(parent.taskId); const definitions = examples();
    const branch = definitions.find(definition => definition.modules.route)!;
    const { graphId } = await main.graphCreate({ definition: branch }) as { graphId: string };
    await main.graphControl({ graphId, nodeId: 'worker', action: 'pause' });
    const failed = { passed: false, reason: 'Revise this version', artifactId: 'review-report', version: 1 };
    await main.graphSend({ graphId, nodeId: 'route', input: 'review', value: failed }); await runtime.host.drive();
    const queue = await main.graphInspect({ graphId, query: 'queue' }) as { items: { nodeId: string; payload: unknown }[] };
    expect(queue.items).toMatchObject([{ nodeId: 'worker', payload: { value: failed } }]);
    const passed = { passed: true, reason: 'Accepted this version', artifactId: 'review-report', version: 2 };
    await main.graphSend({ graphId, nodeId: 'route', input: 'review', value: passed }); await runtime.host.drive();
    await expect(main.graphInspect({ graphId, query: 'results' })).resolves.toMatchObject([{ value: passed }]);
    const complex = definitions.find(definition => definition.modules.join)!;
    const { graphId: joinId } = await main.graphCreate({ definition: complex }) as { graphId: string };
    await main.graphSend({ graphId: joinId, nodeId: 'join', input: 'first', value: passed }); await runtime.host.drive();
    await expect(main.graphInspect({ graphId: joinId, query: 'results' })).resolves.toEqual([]);
    await main.graphSend({ graphId: joinId, nodeId: 'join', input: 'second', value: passed }); await runtime.host.drive();
    await expect(main.graphInspect({ graphId: joinId, query: 'results' })).resolves.toMatchObject([{ value: { first: passed, second: passed } }]);
    await main.graphSend({ graphId: joinId, nodeId: 'join', input: 'second', value: passed }); await runtime.host.drive();
    const results = await main.graphInspect({ graphId: joinId, query: 'results' }) as unknown[];
    expect(results).toHaveLength(1);
    await main.graphSend({ graphId: joinId, nodeId: 'join', input: 'control', value: {} }); await runtime.host.drive();
    await expect(main.graphInspect({ graphId: joinId, query: 'results' })).resolves.toHaveLength(1);
    await main.graphSend({ graphId: joinId, nodeId: 'join', input: 'second', value: passed }); await runtime.host.drive();
    await expect(main.graphInspect({ graphId: joinId, query: 'results' })).resolves.toHaveLength(2);
  } finally { await runtime.close(); await rm(root, { recursive: true, force: true }); }
});
