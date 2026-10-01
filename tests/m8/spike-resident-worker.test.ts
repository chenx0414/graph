import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, test } from 'vitest';
import { openaiServer } from '../fixtures/openai-server.ts';
import { spawnResident, type ResidentHandle } from '../fixtures/resident-host.ts';

/**
 * Spike 1 (Issue #1 §7, §14, §16): a resident Pi worker must survive across turns —
 * same OS process, same session lineage, several model turns — where the current
 * production worker exits after exactly one prompt.
 *
 * Evidence is a repeatable, real end-to-end run: a real child process, a real HTTP
 * model boundary (a scripted openai-compatible server), and control over the real
 * stdin/fd-3 channel. Not a mock of the worker.
 */

const workerEntry = fileURLToPath(new URL('../fixtures/resident-worker-entry.ts', import.meta.url));
const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const action of cleanup.reverse()) await Promise.resolve(action()).catch(() => undefined);
  cleanup.length = 0;
});

test('spike 1: one resident worker keeps its PID and session across three turns', async () => {
  const provider = await openaiServer([
    { text: 'reply one' },
    { text: 'reply two' },
    { text: 'reply three' },
  ]);
  cleanup.push(() => provider.close());
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'graph-resident-')));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const workspace = join(dir, 'workspace');
  const stateDir = join(dir, 'state');
  await mkdir(workspace, { recursive: true });
  await mkdir(stateDir, { recursive: true });

  let worker: ResidentHandle | undefined;
  cleanup.push(() => worker?.stop());
  worker = await spawnResident({
    workerEntry,
    cwd: workspace,
    config: {
      binding: { instanceId: 'agent-1', nodeId: 'worker', definitionVersion: 'worker@1' },
      workspace,
      stateDir,
      model: provider.model,
      thinkingLevel: 'off',
      tools: [],
      nativeTools: [],
      skillPaths: [],
      piExtensionPaths: [],
      piExtensionTools: [],
      systemPrompt: 'You are the worker Agent in Graph.',
      allowedToolNames: [],
      bundleDigest: 'spike-bundle',
      toolPolicyDigest: 'spike-tools',
      runtimePolicyDigest: 'spike-runtime',
    },
  });

  const pid = worker.processId;
  const first = await worker.turn('turn one');
  expect(first.inspect.processId).toBe(pid);
  expect(worker.alive()).toBe(true);
  expect(worker.pidIsStable()).toBe(true);

  const second = await worker.turn('turn two');
  expect(second.inspect.processId).toBe(pid);
  expect(second.turnId).not.toBe(first.turnId);
  expect(worker.alive()).toBe(true);
  expect(worker.pidIsStable()).toBe(true);

  const third = await worker.turn('turn three');
  expect(third.inspect.processId).toBe(pid);

  const inspected = await worker.inspect();
  expect(inspected.processId).toBe(pid);
  expect(worker.alive()).toBe(true);

  // Three real model turns crossed the HTTP boundary.
  expect(provider.requests.length).toBe(3);
  await worker.stop();
  expect(worker.alive()).toBe(false);
});
