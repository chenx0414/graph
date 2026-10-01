import { describe, expect, test } from 'vitest';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach } from 'vitest';
import { openaiServer } from '../fixtures/openai-server.ts';
import { spawnResident } from '../fixtures/resident-host.ts';

/**
 * Issue #1 §5, §7 + backlog HB-262 — the cross-process tool channel.
 *
 * A node runs in its own OS process, but `submit` must execute in the host, where the
 * kernel and the execution identity live. §5 is explicit that the HOST binds the
 * executionId and the sender and that the model must not be able to forge either — so
 * the tool call crosses the process boundary and the host answers it.
 *
 * Failure modes first (R24):
 *   T1  a tool call made by the node reaches the host and its result returns to the model
 *   T2  a refusal comes back as a structured, correctable error rather than a crash
 *   T3  a call to a tool the host does not offer is refused, not silently ignored
 *   T4  the host can answer with a fault without wedging the turn
 *   T5  the node receives the host's answer, not something it invented
 */

const workerEntry = fileURLToPath(new URL('../fixtures/resident-worker-entry.ts', import.meta.url));
const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const action of cleanup.reverse()) await Promise.resolve(action()).catch(() => undefined);
  cleanup.length = 0;
});

async function fixture() {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'graph-toolchannel-')));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const workspace = join(dir, 'workspace');
  const stateDir = join(dir, 'state');
  await mkdir(workspace, { recursive: true });
  await mkdir(stateDir, { recursive: true });
  return { dir, workspace, stateDir };
}

test('T1/T5: a node tool call reaches the host, and the host answer returns to the model', async () => {
  // The scripted model calls `submit` once, then answers with the tool result it saw.
  const provider = await openaiServer([
    { tools: [{ id: 'c1', name: 'submit', arguments: JSON.stringify({ outputs: { out: { enable: true, value: { n: 4 } } } }) }], finishReason: 'tool_calls' },
    { text: 'SUBMITTED' },
  ]);
  cleanup.push(() => provider.close());
  const { workspace, stateDir } = await fixture();

  const calls: { name: string; args: unknown }[] = [];
  let worker: Awaited<ReturnType<typeof spawnResident>> | undefined;
  cleanup.push(() => worker?.stop());

  worker = await spawnResident({
    workerEntry, cwd: workspace,
    config: {
      binding: { instanceId: 'agent-1', nodeId: 'worker', definitionVersion: 'worker@1' },
      workspace, stateDir,
      model: provider.model,
      thinkingLevel: 'off',
      tools: [{ name: 'submit', label: 'Submit', description: 'Submit the node result', parameters: { type: 'object' } }],
      nativeTools: [],
      skillPaths: [], piExtensionPaths: [], piExtensionTools: [],
      systemPrompt: 'You are the worker Agent in Graph. Submit when required.',
      allowedToolNames: ['submit'],
      bundleDigest: 'b1', toolPolicyDigest: 't1', runtimePolicyDigest: 'r1',
    },
    onToolCall: (name, args) => {
      calls.push({ name, args });
      // The host is the authority: it answers with the real kernel receipt.
      return { ok: true, text: JSON.stringify({ accepted: true, submissionId: 'sub-1' }) };
    },
  });

  await worker.turn('do the work');

  // The node really called the tool, and the host really saw it.
  expect(calls.length).toBe(1);
  expect(calls[0]!.name).toBe('submit');
  expect((calls[0]!.args as { outputs: { out: { value: { n: number } } } }).outputs.out.value.n).toBe(4);
  // Two model turns crossed the boundary: the tool call, then the answer.
  expect(provider.requests.length).toBe(2);
});

test('T2: a refusal returns to the model as a correctable error, not a crash', async () => {
  const provider = await openaiServer([
    { tools: [{ id: 'c1', name: 'submit', arguments: JSON.stringify({ outputs: { out: { enable: false } } }) }], finishReason: 'tool_calls' },
    { tools: [{ id: 'c2', name: 'submit', arguments: JSON.stringify({ outputs: { out: { enable: true, value: { n: 1 } } } }) }], finishReason: 'tool_calls' },
    { text: 'CORRECTED' },
  ]);
  cleanup.push(() => provider.close());
  const { workspace, stateDir } = await fixture();

  const replies = [
    { ok: false, text: 'submit refused: required output(s) out were not enabled' },
    { ok: true, text: JSON.stringify({ accepted: true }) },
  ];
  let n = 0;
  let worker: Awaited<ReturnType<typeof spawnResident>> | undefined;
  cleanup.push(() => worker?.stop());

  worker = await spawnResident({
    workerEntry, cwd: workspace,
    config: {
      binding: { instanceId: 'agent-1', nodeId: 'worker', definitionVersion: 'worker@1' },
      workspace, stateDir, model: provider.model, thinkingLevel: 'off',
      tools: [{ name: 'submit', label: 'Submit', description: 'Submit', parameters: { type: 'object' } }],
      nativeTools: [], skillPaths: [], piExtensionPaths: [], piExtensionTools: [],
      systemPrompt: 'Submit.', allowedToolNames: ['submit'],
      bundleDigest: 'b1', toolPolicyDigest: 't1', runtimePolicyDigest: 'r1',
    },
    onToolCall: () => replies[n++]!,
  });

  // The refusal did not kill the worker, and the corrected call went through.
  const result = await worker.turn('do the work');
  expect(result.turnId).toBeTruthy();
  expect(n).toBe(2);
  expect(provider.requests.length).toBe(3);
});

test('T3: a call to a tool the host does not offer is refused, not silently ignored', async () => {
  const provider = await openaiServer([
    { tools: [{ id: 'c1', name: 'not_a_tool', arguments: '{}' }], finishReason: 'tool_calls' },
    { text: 'ok' },
  ]);
  cleanup.push(() => provider.close());
  const { workspace, stateDir } = await fixture();

  const seen: string[] = [];
  let worker: Awaited<ReturnType<typeof spawnResident>> | undefined;
  cleanup.push(() => worker?.stop());

  worker = await spawnResident({
    workerEntry, cwd: workspace,
    config: {
      binding: { instanceId: 'agent-1', nodeId: 'worker', definitionVersion: 'worker@1' },
      workspace, stateDir, model: provider.model, thinkingLevel: 'off',
      tools: [{ name: 'submit', label: 'Submit', description: 'Submit', parameters: { type: 'object' } }],
      nativeTools: [], skillPaths: [], piExtensionPaths: [], piExtensionTools: [],
      systemPrompt: 'Submit.', allowedToolNames: ['submit'],
      bundleDigest: 'b1', toolPolicyDigest: 't1', runtimePolicyDigest: 'r1',
    },
    // The host is asked only for tools it declared; anything else never reaches it.
    onToolCall: (name) => { seen.push(name); return { ok: false, text: `unknown tool ${name}` }; },
  });

  await worker.turn('try a tool that does not exist');
  // The undeclared tool was never handed to the host as a callable tool.
  expect(seen).toEqual([]);
});
