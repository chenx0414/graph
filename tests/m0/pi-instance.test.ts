import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, expect, test } from 'vitest';
import { createAssistantMessageEventStream, type Api, type AssistantMessage, type Model } from '@earendil-works/pi-ai';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { externallyGated, openPiInstance } from '../../src/runtime/pi-instance.ts';
import { modelA, modelB, reply, respond, testModelRuntime } from '../fixtures/models.ts';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** An assistant message that asks for exactly one tool call, like a real turn. */
function toolCallMessage(model: Model<Api>, name: string): AssistantMessage {
  const message = reply(model, '');
  message.content = [{ type: 'toolCall', id: `call-${name}`, name, arguments: {} }];
  message.stopReason = 'toolUse';
  return message;
}

test('an empty persisted session is rejected instead of silently allocating another identity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-session-corruption-')); directories.push(root);
  const options = {
    binding: { instanceId: 'agent-1', nodeId: 'node-1', definitionVersion: 'coder@1' },
    workspace: root, stateDir: join(root, 'state'), model: modelA, modelRuntime: await testModelRuntime(), stream: respond,
  };
  const instance = await openPiInstance(options);
  const { sessionFile } = instance.inspect();
  await instance.close();
  await writeFile(sessionFile, '');
  await expect(openPiInstance(options)).rejects.toThrow('session identity');
});

test.each(['write', 'crash'])('a process exit preserves the exact session (%s)', async mode => {
  const root = await mkdtemp(join(tmpdir(), 'graph-process-'));
  directories.push(root);
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  const run = (mode: string) => promisify(execFile)(process.execPath, [
    'tests/fixtures/instance-process.ts', workspace, join(root, 'state'), mode,
  ]);
  let before;
  try { before = JSON.parse((await run(mode)).stdout); }
  catch (error) {
    const result = error as { code: number; stdout: string };
    expect(result.code).toBe(23);
    before = JSON.parse(result.stdout);
  }
  const after = JSON.parse((await run('read')).stdout);
  expect(after).toEqual(before);
  // Since 0.86 the prompt is the transcript's leading system message: it is stored
  // with the session and survives a process exit exactly like the turns do.
  expect(after.messages[0]).toMatchObject({ role: 'system' });
  expect(after.messages).toHaveLength(mode === 'crash' ? 2 : 3);
});

test('separate instances isolate context and model switching preserves instance identity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-isolation-'));
  directories.push(root);
  const runtime = await testModelRuntime();
  const open = (id: string) => openPiInstance({
    binding: { instanceId: id, nodeId: id, definitionVersion: 'coder@1' },
    workspace: root, stateDir: join(root, id), model: modelA, modelRuntime: runtime, stream: respond,
  });
  const first = await open('one');
  const second = await open('two');
  try {
    await first.prompt('Private context one');
    const before = first.inspect();
    await first.setModel(modelB);
    await first.prompt('Continue with another model');
    expect(first.inspect()).toMatchObject({ binding: before.binding, sessionId: before.sessionId, model: modelB.id });
    expect(first.inspect().messages).toHaveLength(5);
    expect(second.inspect().messages).toEqual([]);
    await expect(openPiInstance({
      binding: { instanceId: 'different', nodeId: 'one', definitionVersion: 'coder@1' },
      workspace: root, stateDir: join(root, 'one'), model: modelA, modelRuntime: runtime, stream: respond,
    })).rejects.toThrow('binding');
  } finally { await first.close(); await second.close(); }
});

test('reopening an Agent instance restores its exact session and transcript', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-instance-'));
  directories.push(root);
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  const options = {
    binding: { instanceId: 'agent-1', nodeId: 'node-1', definitionVersion: 'coder@1' },
    workspace, stateDir: join(root, 'state'),
    model: modelA, modelRuntime: await testModelRuntime(), stream: respond,
  };
  const first = await openPiInstance(options);
  await first.prompt('Remember this task');
  const before = first.inspect();
  await first.close();

  const restored = await openPiInstance(options);
  try {
    expect(restored.inspect()).toMatchObject({
      binding: options.binding, sessionId: before.sessionId,
      sessionFile: before.sessionFile, messages: before.messages,
    });
    expect(restored.inspect().messages).toHaveLength(3);
  } finally {
    await restored.close();
  }
});

test('a transient provider connection error is retried in the same Agent turn', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-instance-retry-'));
  directories.push(root);
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  let requests = 0;
  const instance = await openPiInstance({
    binding: { instanceId: 'agent-retry', nodeId: 'node-retry', definitionVersion: 'coder@1' },
    workspace,
    stateDir: join(root, 'state'),
    model: modelA,
    modelRuntime: await testModelRuntime(),
    stream: (model) => {
      requests += 1;
      const stream = createAssistantMessageEventStream();
      if (requests === 1) {
        const error = reply(model, '');
        error.content = [];
        error.stopReason = 'error';
        error.errorMessage = 'Connection error.';
        stream.push({ type: 'error', reason: 'error', error });
      } else {
        stream.push({ type: 'done', reason: 'stop', message: reply(model, 'Recovered response') });
      }
      return stream;
    },
  });
  try {
    await instance.prompt('Hello');
    expect(requests).toBe(2);
    expect(instance.inspect().messages.at(-1)).toMatchObject({
      role: 'assistant',
      stopReason: 'stop',
      content: [{ type: 'text', text: 'Recovered response' }],
    });
  } finally {
    await instance.close();
  }
});

test('a v3 capability change rebinds through a branched session and v2 migrates only with the legacy digest', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-instance-digest-'));
  directories.push(root);
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  const bundle = {
    bundleDigest: 'a'.repeat(64),
    toolPolicyDigest: 'b'.repeat(64),
    runtimePolicyDigest: 'c'.repeat(64),
  };
  const manifestPath = join(root, 'state', 'instance.json');
  const base = {
    binding: { instanceId: 'agent-digest', nodeId: 'node-digest', definitionVersion: 'coder@1' },
    workspace,
    stateDir: join(root, 'state'),
    model: modelA,
    modelRuntime: await testModelRuntime(),
    stream: respond,
  };
  const first = await openPiInstance({ ...base, ...bundle });
  await first.prompt('Persist with capability A');
  const before = first.inspect();
  await first.close();

  await expect(openPiInstance(base)).rejects.toThrow('capability bundle digest is required');
  const reboundBundle = { ...bundle, bundleDigest: 'd'.repeat(64) };
  const rebound = await openPiInstance({ ...base, ...reboundBundle });
  const after = rebound.inspect();
  expect(after.sessionId).not.toBe(before.sessionId);
  expect(after.messages).toEqual(before.messages);
  expect(after.context).toMatchObject({
    mode: 'rebind',
    sourceSessionId: before.sessionId,
    reboundFromBundleDigest: bundle.bundleDigest,
  });
  await rebound.close();
  expect(JSON.parse(await readFile(manifestPath, 'utf8'))).toMatchObject({
    version: 3,
    bundleDigest: reboundBundle.bundleDigest,
    toolPolicyDigest: reboundBundle.toolPolicyDigest,
    runtimePolicyDigest: reboundBundle.runtimePolicyDigest,
  });

  const same = await openPiInstance({ ...base, ...reboundBundle });
  await same.close();

  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>;
  const legacy = { ...manifest, version: 2, capabilityDigest: 'e'.repeat(64) } as Record<string, unknown>;
  delete legacy.bundleDigest;
  delete legacy.toolPolicyDigest;
  delete legacy.runtimePolicyDigest;
  delete legacy.model;
  delete legacy.thinkingLevel;
  delete legacy.activeTools;
  delete legacy.registeredTools;
  delete legacy.loadedExtensions;
  delete legacy.loadedExtensionTools;
  delete legacy.piVersion;
  await writeFile(manifestPath, JSON.stringify(legacy));
  await expect(openPiInstance({ ...base, ...bundle })).rejects.toThrow('legacy capability digest is required');
  // A v2 mismatch rebinds exactly like v3: the conversation survives a legacy bundle change.
  const v2Rebound = await openPiInstance({ ...base, ...bundle, legacyCapabilityDigest: 'f'.repeat(64) });
  await v2Rebound.close();
  expect(JSON.parse(await readFile(manifestPath, 'utf8'))).toMatchObject({
    version: 3,
    bundleDigest: bundle.bundleDigest,
  });
  const migrated = await openPiInstance({ ...base, ...bundle, legacyCapabilityDigest: 'e'.repeat(64) });
  await migrated.close();
  expect(JSON.parse(await readFile(manifestPath, 'utf8'))).toMatchObject({
    version: 3,
    bundleDigest: bundle.bundleDigest,
    toolPolicyDigest: bundle.toolPolicyDigest,
    runtimePolicyDigest: bundle.runtimePolicyDigest,
    model: modelA.id,
    thinkingLevel: 'off',
  });

  const v3 = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>;
  delete v3.bundleDigest;
  await writeFile(manifestPath, JSON.stringify(v3));
  await expect(openPiInstance({ ...base, ...bundle })).rejects.toThrow('has no digest');
});

test('the session constructor uses the exact tool allowlist instead of activating built-ins', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-instance-tools-'));
  directories.push(root);
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  const probe = externallyGated({
    name: 'probe',
    label: 'Probe',
    description: 'Probe the exact allowlist.',
    parameters: { type: 'object', properties: {} },
    execute: async () => ({ content: [{ type: 'text' as const, text: 'ok' }], details: {} }),
  });
  const instance = await openPiInstance({
    binding: { instanceId: 'agent-tools', nodeId: 'node-tools', definitionVersion: 'coder@1' },
    workspace,
    stateDir: join(root, 'state'),
    model: modelA,
    modelRuntime: await testModelRuntime(),
    stream: respond,
    tools: [probe],
  });
  try {
    const inspect = instance.inspect();
    expect(inspect.activeTools).toEqual(['probe']);
    expect(inspect.registeredTools).toContain('probe');
    expect(inspect.activeTools).not.toContain('read');
    expect(inspect.activeTools).not.toContain('bash');
  } finally {
    await instance.close();
  }
});

test('freshSession starts a new session for an existing instance identity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-fresh-session-'));
  directories.push(root);
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  const runtime = await testModelRuntime();
  const options = {
    binding: { instanceId: 'review', nodeId: 'review', definitionVersion: 'reviewer@1' },
    workspace,
    stateDir: join(root, 'state'),
    model: modelA,
    modelRuntime: runtime,
    stream: respond,
  };
  const first = await openPiInstance(options);
  await first.prompt('first independent review');
  const firstSession = first.inspect().sessionId;
  await first.close();

  const fresh = await openPiInstance({ ...options, freshSession: true });
  expect(fresh.inspect().sessionId).not.toBe(firstSession);
  await fresh.close();
});

test('a fork rejects a source/child context digest mismatch before any model request', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-fork-digest-'));
  directories.push(root);
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  const runtime = await testModelRuntime();
  const sourceOptions = {
    binding: { instanceId: 'source', nodeId: 'source', definitionVersion: 'coder@1' },
    workspace,
    stateDir: join(root, 'source'),
    model: modelA,
    modelRuntime: runtime,
    stream: respond,
  };
  const source = await openPiInstance(sourceOptions);
  await source.prompt('source context');
  const sourceFile = source.inspect().sessionFile;
  await source.close();

  let modelRequests = 0;
  const original = SessionManager.prototype.buildSessionContext;
  SessionManager.prototype.buildSessionContext = function patched() {
    return {
      messages: [{ role: 'assistant', content: [{ type: 'text', text: 'tampered child context' }], timestamp: 1 }],
      thinkingLevel: 'off',
      model: null,
    } as ReturnType<typeof original>;
  };
  try {
    await expect(openPiInstance({
      binding: { instanceId: 'fork', nodeId: 'fork', definitionVersion: 'coder@1' },
      workspace,
      stateDir: join(root, 'fork'),
      model: modelA,
      modelRuntime: runtime,
      stream: (...args) => { modelRequests += 1; return respond(...args); },
      forkFrom: { sessionFile: sourceFile },
    })).rejects.toThrow('context digest mismatch');
    expect(modelRequests).toBe(0);
  } finally {
    SessionManager.prototype.buildSessionContext = original;
  }
});

test('stop soft-stops the running turn: the in-flight tool finishes and no further model request is sent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-instance-stop-'));
  directories.push(root);
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  let instance: Awaited<ReturnType<typeof openPiInstance>> | undefined;
  let modelRequests = 0;
  let toolRuns = 0;
  const probe = externallyGated({
    name: 'probe', label: 'Probe', description: 'Stop the turn while this call is in flight.',
    parameters: { type: 'object', properties: {} },
    execute: async () => {
      toolRuns += 1;
      await instance!.stop();
      return { content: [{ type: 'text' as const, text: 'probe finished' }], details: {} };
    },
  });
  const stream: StreamFn = model => {
    modelRequests += 1;
    const output = createAssistantMessageEventStream();
    const message = modelRequests === 1 ? toolCallMessage(model, 'probe') : reply(model, 'Resumed response');
    output.push({ type: 'done', reason: message.stopReason === 'toolUse' ? 'toolUse' : 'stop', message });
    return output;
  };
  instance = await openPiInstance({
    binding: { instanceId: 'agent-stop', nodeId: 'node-stop', definitionVersion: 'coder@1' },
    workspace, stateDir: join(root, 'state'), model: modelA, modelRuntime: await testModelRuntime(),
    stream, tools: [probe],
  });
  try {
    const sessionId = instance.inspect().sessionId;
    await instance.prompt('Run the probe');
    // The in-flight tool call finished, but the turn ended instead of asking the model again.
    expect(toolRuns).toBe(1);
    expect(modelRequests).toBe(1);
    expect(instance.inspect().messages.at(-1)).toMatchObject({ role: 'toolResult', toolName: 'probe' });
    // The soft stop retained the session (no dispose), so the next prompt continues it.
    await instance.prompt('Continue after the stop');
    expect(modelRequests).toBe(2);
    expect(instance.inspect().sessionId).toBe(sessionId);
    expect(instance.inspect().messages.at(-1)).toMatchObject({
      role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'Resumed response' }],
    });
  } finally {
    await instance.close();
  }
});

test('stop with no running turn is idempotent and leaves the session usable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-instance-stop-idle-'));
  directories.push(root);
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  const instance = await openPiInstance({
    binding: { instanceId: 'agent-stop-idle', nodeId: 'node-stop-idle', definitionVersion: 'coder@1' },
    workspace, stateDir: join(root, 'state'), model: modelA, modelRuntime: await testModelRuntime(), stream: respond,
  });
  try {
    await expect(instance.stop()).resolves.toBeUndefined();
    await expect(instance.stop()).resolves.toBeUndefined();
    await instance.prompt('After an idle stop');
    expect(instance.inspect().messages.at(-1)).toMatchObject({
      role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'Saved response' }],
    });
  } finally {
    await instance.close();
  }
});

test('a large tool result reaches the model in full twice and as a readable summary with a handle afterwards', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-instance-tool-results-'));
  directories.push(root);
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  const big = `head-marker\n${'line\n'.repeat(4_000)}tail-marker`;
  let modelRequests = 0;
  const probe = externallyGated({
    name: 'probe', label: 'Probe', description: 'Return a large result every time.',
    parameters: { type: 'object', properties: {} },
    execute: async () => ({ content: [{ type: 'text' as const, text: big }], details: {} }),
  });
  const stream: StreamFn = model => {
    modelRequests += 1;
    const output = createAssistantMessageEventStream();
    const message = modelRequests <= 3 ? toolCallMessage(model, 'probe') : reply(model, 'Done');
    output.push({ type: 'done', reason: message.stopReason === 'toolUse' ? 'toolUse' : 'stop', message });
    return output;
  };
  const instance = await openPiInstance({
    binding: { instanceId: 'agent-tool-results', nodeId: 'node-tool-results', definitionVersion: 'coder@1' },
    workspace, stateDir: join(root, 'state'), model: modelA, modelRuntime: await testModelRuntime(),
    stream, tools: [probe],
  });
  try {
    await instance.prompt('Run the probe three times');
    expect(modelRequests).toBe(4);
    const results = instance.inspect().messages.filter(message => message.role === 'toolResult');
    expect(results).toHaveLength(3);
    const textOf = (message: (typeof results)[number]) =>
      (message.content as { type: string; text?: string }[]).map(part => part.text ?? '').join('');

    // The first two views are the tool's own result, byte for byte.
    expect(textOf(results[0]!)).toBe(big);
    expect(textOf(results[1]!)).toBe(big);

    // The third is bounded, still shows the head, and names a readable handle.
    const third = textOf(results[2]!);
    expect(third.length).toBeLessThanOrEqual(1_024);
    expect(third).toContain('head-marker');
    expect(third).toContain('omitted');
    const handle = /handle: (\S+)/.exec(third)?.[1];
    expect(handle).toBeTruthy();
    expect(await readFile(handle!, 'utf8')).toBe(big);
  } finally {
    await instance.close();
  }
});
