import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';
import { describe, expect, test } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach } from 'vitest';
import { openaiServer } from '../fixtures/openai-server.ts';
import { spawnResident } from '../fixtures/resident-host.ts';

/**
 * Issue #1 §7 — the resident worker must reach a real provider with the credential the
 * HOST resolved, not with a spike placeholder.
 *
 * The worker's own header says why this matters: registering a provider with only an
 * apiKey is not enough for the native HTTP path, which is why the worker overrides the
 * stream. The stream it built was hardwired to `'spike-credential'`, so a node could
 * never run a real model from the kernel. The host owns the credential (§3: the host
 * binds identity and metering), so the worker must take the transport facts from the
 * config the host wrote.
 *
 * Failure modes first (R24):
 *   X1  a configured apiKey reaches the provider on the wire
 *   X2  an api the worker does not support is refused, not silently downgraded
 *   X3  with no transport in the config, the worker still runs (test/spike compatibility)
 */

const workerEntry = fileURLToPath(new URL('../../src/runtime/resident-worker-entry.ts', import.meta.url));
const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const action of cleanup.reverse()) await Promise.resolve(action()).catch(() => undefined); cleanup.length = 0; });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'resident-transport-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, 'workspace');
  const stateDir = join(root, 'state');
  await mkdir(workspace, { recursive: true });
  await mkdir(stateDir, { recursive: true });
  return { workspace, stateDir };
}

function baseConfig(workspace: string, stateDir: string, model: unknown) {
  return {
    binding: { instanceId: 'i', nodeId: 'a', definitionVersion: 'a@1' },
    workspace, stateDir, model: model as never, thinkingLevel: 'off' as const,
    tools: [] as never[], nativeTools: [], skillPaths: [], piExtensionPaths: [], piExtensionTools: [],
    systemPrompt: 'Work.', allowedToolNames: [] as string[],
    bundleDigest: 'b', toolPolicyDigest: 't', runtimePolicyDigest: 'r',
  };
}

describe('resident worker transport (§7)', () => {
  test('X1: the host-configured apiKey is what reaches the provider', async () => {
    const provider = await openaiServer([{ text: 'done' }]);
    cleanup.push(() => provider.close());
    const { workspace, stateDir } = await fixture();

    const worker = await spawnResident({
      workerEntry, cwd: workspace,
      config: { ...baseConfig(workspace, stateDir, provider.model), transport: { apiKey: 'host-resolved-key', api: 'openai-completions' } },
    });
    cleanup.push(() => worker.stop());

    await worker.turn('go');
    expect(provider.authorizations.length).toBeGreaterThanOrEqual(1);
    expect(provider.authorizations[0]).toContain('host-resolved-key');
  }, 60_000);

  test('X2: an unsupported api is refused, not silently downgraded', async () => {
    const provider = await openaiServer([{ text: 'done' }]);
    cleanup.push(() => provider.close());
    const { workspace, stateDir } = await fixture();

    // A worker that cannot build the requested transport must die at startup, not fall
    // back to the placeholder credential and run anyway. The host sees an early exit.
    await expect(spawnResident({
      workerEntry, cwd: workspace,
      config: { ...baseConfig(workspace, stateDir, provider.model), transport: { apiKey: 'k', api: 'not-a-transport' as never } },
    })).rejects.toThrow(/exited before ready|transport/i);
  }, 60_000);

  test('X3: without a transport the worker still runs (spike compatibility)', async () => {
    const provider = await openaiServer([{ text: 'done' }]);
    cleanup.push(() => provider.close());
    const { workspace, stateDir } = await fixture();

    const worker = await spawnResident({ workerEntry, cwd: workspace, config: baseConfig(workspace, stateDir, provider.model) });
    cleanup.push(() => worker.stop());
    const result = await worker.turn('go');
    expect(result.turnId).toBeTruthy();
  }, 60_000);
});


test.each(['idle', 'model_call', 'tool_call'])('a resident Pi closes when its owner control stream closes during %s', async operation => {
  const provider = await openaiServer([{ tools: [{ id: 'probe-1', name: 'probe', arguments: '{}' }] }]);
  cleanup.push(() => provider.close());
  const { workspace, stateDir } = await fixture();
  const configPath = join(workspace, 'owner-eof.json');
  await writeFile(configPath, JSON.stringify({ ...baseConfig(workspace, stateDir, provider.model),
    hostModel: operation === 'model_call',
    tools: [{ name: 'probe', label: 'Probe', description: 'Ask the host.', parameters: { type: 'object', properties: {} } }],
    allowedToolNames: ['probe'],
  }));
  const worker = spawn(process.execPath, [workerEntry, configPath], { cwd: workspace, stdio: ['pipe', 'ignore', 'pipe', 'pipe'] });
  const closed = once(worker, 'close');
  const messages: { operation?: string }[] = [];
  const channel = createInterface({ input: worker.stdio[3] as Readable });
  channel.on('line', line => { messages.push(JSON.parse(line) as { operation?: string }); });
  cleanup.push(async () => {
    if (worker.exitCode === null && worker.signalCode === null) worker.kill('SIGKILL');
    await closed; channel.close();
  });
  await expect.poll(() => messages.some(message => message.operation === 'ready'), { timeout: 10000 }).toBe(true);
  if (operation !== 'idle') {
    worker.stdin!.write(`${JSON.stringify({ operation: 'start-turn', requestId: 'turn-1', text: 'Ask the host.' })}\n`);
    await expect.poll(() => messages.some(message => message.operation === operation), { timeout: 10000 }).toBe(true);
  }
  const requestsBefore = provider.requests.length;
  worker.stdin!.end();
  await expect.poll(() => worker.exitCode, { timeout: 5000 }).toBe(0);
  await closed;
  expect(provider.requests).toHaveLength(requestsBefore);
}, 20000);
