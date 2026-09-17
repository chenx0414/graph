import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, expect, test } from 'vitest';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { openPiInstance } from '../../src/runtime/pi-instance.ts';
import { modelA, modelB, respond, testModelRuntime } from '../fixtures/models.ts';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

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
  expect(after.messages).toHaveLength(mode === 'crash' ? 1 : 2);
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
    expect(first.inspect().messages).toHaveLength(4);
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
    expect(restored.inspect().messages).toHaveLength(2);
  } finally {
    await restored.close();
  }
});

test('a v2 capability digest is required and must match exactly', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-instance-digest-'));
  directories.push(root);
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  const base = {
    binding: { instanceId: 'agent-digest', nodeId: 'node-digest', definitionVersion: 'coder@1' },
    workspace,
    stateDir: join(root, 'state'),
    model: modelA,
    modelRuntime: await testModelRuntime(),
    stream: respond,
  };
  const first = await openPiInstance({ ...base, capabilityDigest: 'a'.repeat(64) });
  await first.prompt('Persist with capability A');
  await first.close();

  await expect(openPiInstance(base)).rejects.toThrow('capability digest is required');
  await expect(openPiInstance({ ...base, capabilityDigest: 'b'.repeat(64) })).rejects.toThrow('does not match');

  const same = await openPiInstance({ ...base, capabilityDigest: 'a'.repeat(64) });
  await same.close();

  const manifestPath = join(root, 'state', 'instance.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>;
  delete manifest.capabilityDigest;
  await writeFile(manifestPath, JSON.stringify(manifest));
  await expect(openPiInstance({ ...base, capabilityDigest: 'a'.repeat(64) })).rejects.toThrow('has no digest');
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
