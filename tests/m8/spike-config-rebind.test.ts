import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, test } from 'vitest';
import { openaiServer } from '../fixtures/openai-server.ts';
import { spawnResident, type ResidentHandle } from '../fixtures/resident-host.ts';

/**
 * Spike 2 (Issue #1 §7, §11, §16): a capability/identity change must rebuild the
 * resident process BETWEEN turns while keeping the session lineage, recording a
 * `rebind` (ADR 0011). The unit that must not be lost is the conversation, not the
 * process: stopping the worker and starting a new one with a different bundle
 * digest must resume the same conversation under the new bundle.
 */

const workerEntry = fileURLToPath(new URL('../fixtures/resident-worker-entry.ts', import.meta.url));
const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const action of cleanup.reverse()) await Promise.resolve(action()).catch(() => undefined);
  cleanup.length = 0;
});

const baseConfig = (workspace: string, stateDir: string, model: unknown, bundleDigest: string) => ({
  binding: { instanceId: 'agent-1', nodeId: 'worker', definitionVersion: 'worker@1' },
  workspace,
  stateDir,
  model,
  thinkingLevel: 'off',
  tools: [],
  nativeTools: [],
  skillPaths: [],
  piExtensionPaths: [],
  piExtensionTools: [],
  systemPrompt: 'You are the worker Agent in Graph.',
  allowedToolNames: [],
  bundleDigest,
  toolPolicyDigest: 'tools-1',
  runtimePolicyDigest: 'runtime-1',
});

test('spike 2: a new bundle digest rebinds the conversation across a process restart', async () => {
  const provider = await openaiServer([{ text: 'first bundle reply' }, { text: 'second bundle reply' }]);
  cleanup.push(() => provider.close());
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'graph-rebind-')));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const workspace = join(dir, 'workspace');
  const stateDir = join(dir, 'state');
  await mkdir(workspace, { recursive: true });
  await mkdir(stateDir, { recursive: true });

  let first: ResidentHandle | undefined;
  cleanup.push(() => first?.stop());
  first = await spawnResident({ workerEntry, cwd: workspace, config: baseConfig(workspace, stateDir, provider.model, 'bundle-a') });
  const firstPid = first.processId;
  const turnA = await first.turn('work under bundle A');
  expect(turnA.inspect.processId).toBe(firstPid);
  const sessionAfterA = turnA.inspect.sessionId;
  await first.stop();
  expect(first.alive()).toBe(false);

  // Rebuild the process with a new capability bundle; the same instance must
  // resume its conversation rather than start a fresh session.
  let second: ResidentHandle | undefined;
  cleanup.push(() => second?.stop());
  second = await spawnResident({ workerEntry, cwd: workspace, config: baseConfig(workspace, stateDir, provider.model, 'bundle-b') });
  expect(second.processId).not.toBe(firstPid);
  const startInspect = await second.inspect();
  expect(startInspect.sessionId).not.toBe(sessionAfterA);

  const turnB = await second.turn('continue under bundle B');
  // The conversation carried over: the worker's transcript still holds the
  // earlier exchange, and the model saw it.
  const roles = (turnB.inspect.messages as { role: string }[]).map(message => message.role);
  expect(roles.filter(role => role === 'user').length).toBeGreaterThanOrEqual(2);
  expect(provider.requests.length).toBe(2);
  await second.stop();
});
