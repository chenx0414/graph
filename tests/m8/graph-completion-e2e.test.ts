import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { openaiServer } from '../fixtures/openai-server.ts';
import { openTaskRuntime } from '../../src/core/task-runtime.ts';
import { parseGraphDefinition } from '../../src/core/interface-spec.ts';

// Real public graph commands, HTTP model decisions, durable tools and disk-backed
// delivery. An invalid call must be correctable without consuming submission.
test('a durable graph refuses malformed and undeclared tools, accepts corrected output, and routes it to an independent node', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-complete-durable-'));
  const output = (name: string, n: number) => JSON.stringify({ outputs: { [name]: { enable: true, value: { n } } } });
  const provider = await openaiServer([
    { tools: [{ id: 'unknown', name: 'not_a_tool', arguments: '{}' }] },
    { tools: [{ id: 'malformed', name: 'submit', arguments: JSON.stringify({ verdict: JSON.parse(output('out', 42)) }) }] },
    { tools: [{ id: 'correct', name: 'submit', arguments: output('out', 42) }] },
    { text: 'a done.' },
    { tools: [{ id: 'second', name: 'submit', arguments: output('done', 43) }] },
    { text: 'b done.' },
  ]);
  const options = { stateDir: join(root, 'state'), projects: [{ id: 'p', root }],
    models: { entries: [{ id: 'local', provider: provider.model.provider, grade: 'medium' as const, api: 'openai-completions' as const,
      baseUrl: provider.model.baseUrl, contextWindow: 32000, maxTokens: 256 }], apiKey: 'host-only-key', modelRuntime: provider.runtime } };
  let runtime = await openTaskRuntime(options);
  try {
    for (const id of ['a', 'b']) runtime.catalog.publishDefinition(id, { recommendedGrade: 'medium' }, id);
    const { taskId } = await runtime.user.begin({ projectId: 'p', request: 'produce and consume a number', requestId: 'begin' });
    const main = runtime.supervisor(taskId);
    const { graphId } = await main.graphCreate({ definition: parseGraphDefinition({ schemaVersion: 2, name: 'real-completion',
      protocols: { ping: { type: 'object', required: ['n'], properties: { n: { type: 'number' } } } },
      nodes: {
        a: { recipe: 'a@1', model: 'local', task: 'produce a number', inputs: { start: { protocol: 'ping' } }, outputs: { out: { protocol: 'ping' } }, submission: { required: ['out'] } },
        b: { recipe: 'b@1', model: 'local', task: 'receive the number', inputs: { in: { protocol: 'ping' } }, outputs: { done: { protocol: 'ping' } }, submission: { required: ['done'] } },
      }, modules: {}, edges: { e: { from: 'a.out', to: 'b.in', enabled: true } }, outputs: { result: { from: 'b.done', protocol: 'ping' } },
    }) }) as { graphId: string };
    await main.graphSend({ graphId, nodeId: 'a', input: 'start', value: { n: 0 } });
    await runtime.host.drive();
    expect(provider.requests).toHaveLength(6);
    const messages = (index: number) => (provider.requests[index] as { messages: { role: string; content: string }[] }).messages;
    const toolReply = (index: number) => messages(index).filter(message => message.role === 'tool').at(-1)?.content;
    expect(toolReply(1)).toMatch(/not_a_tool|unknown tool|not found/i);
    expect(toolReply(2)).toMatch(/Validation failed|submit refused/);
    expect(toolReply(2)).toContain('outputs');
    expect(toolReply(2)).not.toContain('missing_required_output');
    expect(toolReply(3)).toContain('"accepted":true');
    expect(JSON.stringify(messages(4))).toContain('42');
    expect(JSON.stringify(messages(4))).not.toContain('a done.');
    expect(await main.graphInspect({ graphId, query: 'results' })).toMatchObject([{ value: { n: 43 } }]);
    expect(await main.graphInspect({ graphId, query: 'acceptance' })).toMatchObject({ drained: true });
    const edge = await main.graphInspect({ graphId, query: 'edge', id: 'e' });
    expect(edge).toMatchObject({ deliveries: [{ value: { n: 42 } }] });
    const a = runtime.nodeRun(graphId, 'a'); const b = runtime.nodeRun(graphId, 'b');
    expect(a.operations).toMatchObject([{ state: 'completed' }]);
    expect(b.operations).toMatchObject([{ state: 'completed' }]);
    expect(a.session?.sessionId).not.toBe(b.session?.sessionId);
    expect(a.instance?.used).toBeGreaterThan(0); expect(b.instance?.used).toBeGreaterThan(0);
    await runtime.close(); runtime = await openTaskRuntime(options);
    const reopened = runtime.supervisor(taskId);
    expect(await reopened.graphInspect({ graphId, query: 'edge', id: 'e' })).toEqual(edge);
    expect(await reopened.graphInspect({ graphId, query: 'results' })).toMatchObject([{ value: { n: 43 } }]);
    await runtime.host.drive(); expect(provider.requests).toHaveLength(6);
  } finally { await runtime.close(); await provider.close(); await rm(root, { recursive: true, force: true }); }
}, 60_000);
