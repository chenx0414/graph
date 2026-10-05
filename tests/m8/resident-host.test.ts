import { mkdtemp, mkdir, realpath, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Api, Model } from '@earendil-works/pi-ai';
import { afterEach, expect, test } from 'vitest';
import { openaiServer } from '../fixtures/openai-server.ts';
import { residentLauncher } from '../../src/runtime/resident-launcher.ts';
import { ResidentHost } from '../../src/runtime/resident-host.ts';

/**
 * Phase 3 (Issue #1 §7, §13.3): the kernel's resident-process manager.
 *
 * Failure modes first (R24):
 *   H1  several turns on one process                       -> same PID, same session
 *   H2  the process crashes mid-life                       -> start() rebuilds it
 *   H3  after a rebuild the session lineage is kept        -> the transcript carries over
 *   H4  a config (capability) change rebinds, not resets   -> new process, conversation kept
 *   H5  stop() then turn()                                 -> refused, not a silent no-op
 *
 * Evidence is a real child process against a scripted HTTP model boundary.
 */

const workerEntry = fileURLToPath(new URL('../../src/runtime/resident-worker-entry.ts', import.meta.url));
const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const action of cleanup.reverse()) await Promise.resolve(action()).catch(() => undefined);
  cleanup.length = 0;
});

async function workspace() {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'graph-host-')));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const work = join(dir, 'workspace');
  const stateDir = join(dir, 'state');
  await mkdir(work, { recursive: true });
  await mkdir(stateDir, { recursive: true });
  return { work, stateDir };
}

const configFor = (work: string, stateDir: string, model: Model<Api>, bundleDigest: string) => ({
  binding: { instanceId: 'i-a', nodeId: 'a', definitionVersion: 'worker@1' },
  workspace: work, stateDir, model, thinkingLevel: 'off' as const,
  tools: [], nativeTools: [], skillPaths: [], piExtensionPaths: [], piExtensionTools: [],
  systemPrompt: 'You are node a.', allowedToolNames: [],
  bundleDigest, toolPolicyDigest: 'tools', runtimePolicyDigest: 'runtime',
});

test('H1: several turns run on one resident process with the same PID', async () => {
  const provider = await openaiServer([{ text: 'one' }, { text: 'two' }, { text: 'three' }]);
  cleanup.push(() => provider.close());
  const { work, stateDir } = await workspace();
  const host = new ResidentHost({ workerEntry, cwd: work, configPath: join(work, 'w.json'), config: configFor(work, stateDir, provider.model, 'b1') });
  cleanup.push(() => host.stop());
  const ready = await host.start();
  const pid = ready.processId;
  expect((await host.turn('t1')).inspect.processId).toBe(pid);
  expect((await host.turn('t2')).inspect.processId).toBe(pid);
  expect((await host.turn('t3')).inspect.processId).toBe(pid);
  expect(host.pidIsStable()).toBe(true);
  expect(host.spawnCount()).toBe(1);
  expect(provider.requests.length).toBe(3);
});

test('H2/H3: after a crash, start() rebuilds the process and the conversation survives', async () => {
  const provider = await openaiServer([{ text: 'before crash' }, { text: 'after crash' }]);
  cleanup.push(() => provider.close());
  const { work, stateDir } = await workspace();
  const host = new ResidentHost({ workerEntry, cwd: work, configPath: join(work, 'w.json'), config: configFor(work, stateDir, provider.model, 'b1') });
  cleanup.push(() => host.stop());
  const first = await host.start();
  const before = await host.turn('work before the crash');
  expect(before.inspect.sessionId).toBeTruthy();
  // Simulate a crash: kill the process without a clean close.
  const child = (host as unknown as { child?: { kill(signal?: string): boolean } }).child;
  child?.kill('SIGKILL');
  await new Promise(resolve => setTimeout(resolve, 300));
  expect(host.alive()).toBe(false);
  expect(host.pidIsStable()).toBe(false);

  const rebuilt = await host.start();
  expect(rebuilt.processId).not.toBe(first.processId);
  expect(host.spawnCount()).toBe(2);
  const after = await host.turn('continue after the crash');
  // The session lineage carried over: the transcript still holds the earlier turn.
  const roles = (after.inspect.messages as { role: string }[]).map(message => message.role);
  expect(roles.filter(role => role === 'user').length).toBeGreaterThanOrEqual(2);
  expect(provider.requests.length).toBe(2);
});

test('H4: a capability change rebuilds the process with a new bundle and keeps the conversation', async () => {
  const provider = await openaiServer([{ text: 'bundle one' }, { text: 'bundle two' }]);
  cleanup.push(() => provider.close());
  const { work, stateDir } = await workspace();
  const host = new ResidentHost({ workerEntry, cwd: work, configPath: join(work, 'w.json'), config: configFor(work, stateDir, provider.model, 'bundle-1') });
  cleanup.push(() => host.stop());
  const first = await host.start();
  const a = await host.turn('under bundle 1');
  expect(a.inspect.bundleDigest).toBe('bundle-1');

  // A new capability bundle takes effect by rebuilding the process between turns.
  const rebind = new ResidentHost({ workerEntry, cwd: work, configPath: join(work, 'w.json'), config: configFor(work, stateDir, provider.model, 'bundle-2') });
  cleanup.push(() => rebind.stop());
  const second = await rebind.start();
  expect(second.processId).not.toBe(first.processId);
  const b = await rebind.turn('under bundle 2');
  expect(b.inspect.bundleDigest).toBe('bundle-2');
  const roles = (b.inspect.messages as { role: string }[]).map(message => message.role);
  expect(roles.filter(role => role === 'user').length).toBeGreaterThanOrEqual(2);
});

test('H5: a turn after stop() is refused, not silently dropped', async () => {
  const provider = await openaiServer([{ text: 'x' }]);
  cleanup.push(() => provider.close());
  const { work, stateDir } = await workspace();
  const host = new ResidentHost({ workerEntry, cwd: work, configPath: join(work, 'w.json'), config: configFor(work, stateDir, provider.model, 'b1') });
  await host.start();
  await host.turn('live');
  await host.stop();
  expect(host.alive()).toBe(false);
  await expect(host.turn('after stop')).rejects.toThrow(/not running/);
});


test('a process exit during a pending turn rejects promptly instead of leaving the node busy', async () => {
  let requested!: () => void;
  let release!: () => void;
  const arrived = new Promise<void>(resolve => { requested = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const provider = await openaiServer([{ text: 'never delivered', beforeReply: async () => { requested(); await held; } }]);
  cleanup.push(() => provider.close());
  cleanup.push(() => release());
  const { work, stateDir } = await workspace();
  const host = new ResidentHost({ workerEntry, cwd: work, configPath: join(work, 'w.json'), config: configFor(work, stateDir, provider.model, 'crash') });
  cleanup.push(() => host.stop());
  await host.start();
  const turn = host.turn('work');
  const rejected = expect(turn).rejects.toThrow(/exited/);
  await arrived;
  process.kill(host.pid()!, 'SIGKILL');
  await rejected;
});

// This protects the resident transport's permission boundary, absent from direct-spawn H1:
// a regression to unrestricted spawn lets an extension read outside its declared roots.
test('resident Pi keeps its session while extension code obeys the OS grants', async () => {
  const provider = await openaiServer([{ text: 'first' }, { text: 'second' }]);
  cleanup.push(() => provider.close());
  const { work, stateDir } = await workspace();
  const outside = join(stateDir, '..', 'private.txt');
  await writeFile(outside, 'outside-granted-roots');
  const extension = join(work, 'permission-probe.ts');
  await writeFile(extension, `import {readFileSync, writeFileSync} from 'node:fs';
    export default function() {
      let outside = 'allowed';
      try { readFileSync(${JSON.stringify(outside)}, 'utf8'); } catch { outside = 'denied'; }
      writeFileSync(${JSON.stringify(join(work, 'permission-result.json'))}, JSON.stringify({outside}));
    }`);
  const config = { ...configFor(work, stateDir, provider.model, 'sandboxed'),
    piExtensionPaths: [extension], transport: { apiKey: 'local-fixture', api: 'openai-completions' as const } };
  const configPath = join(stateDir, 'config.json');
  const host = new ResidentHost({ workerEntry, cwd: work, configPath, config,
    launch: residentLauncher({ config, configPath, workerEntry, operation: {
      readRoots: [], writeRoots: [], unixSockets: [], env: {},
      networkDomains: ['127.0.0.1'], allowUnrestrictedNetwork: false, allowLocalBinding: true,
    } }),
  });
  cleanup.push(() => host.stop());
  const ready = await host.start();
  expect(JSON.parse(await readFile(join(work, 'permission-result.json'), 'utf8'))).toEqual({ outside: 'denied' });
  const first = await host.turn('first turn');
  const second = await host.turn('second turn');
  expect(second.inspect.processId).toBe(ready.processId);
  expect(second.inspect.sessionId).toBe(first.inspect.sessionId);
  expect(provider.requests).toHaveLength(2);
  await host.stop();
  expect(host.alive()).toBe(false);
  expect(await readFile(outside, 'utf8')).toBe('outside-granted-roots');
}, 60_000);
