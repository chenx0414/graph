import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import type { AgentSessionRequest } from '../../src/runtime/agent-session.ts';
import { createDurableSessionTransport } from '../../src/runtime/durable-session.ts';
import { TaskStore } from '../../src/core/store.ts';
import { CallBroker } from '../../src/runtime/call-broker.ts';

/** Real durable transport plus its disk-backed lifecycle for provider/tool tests. */
export async function openDurableAgent(options: Omit<AgentSessionRequest, 'bundleDigest' | 'toolPolicyDigest' | 'runtimePolicyDigest' | 'broker'> & {
  bundleDigest?: string;
  toolPolicyDigest?: string;
  runtimePolicyDigest?: string;
  broker?: AgentSessionRequest['broker'];
  modelRuntime?: ModelRuntime;
}) {
  await mkdir(options.stateDir, { recursive: true });
  const store = new TaskStore(join(options.stateDir, 'durable.sqlite'));
  const transport = await createDurableSessionTransport(store);
  const ownedBroker = options.broker ? undefined : new CallBroker(join(options.stateDir, 'calls.sqlite'), options.binding.instanceId);
  try {
    let request = { ...options, broker: options.broker ?? ownedBroker!, bundleDigest: options.bundleDigest ?? 'fixture-bundle', toolPolicyDigest: options.toolPolicyDigest ?? 'fixture-tools', runtimePolicyDigest: options.runtimePolicyDigest ?? 'fixture-runtime' };
    let session = await transport.open(request);
    return { prompt: (...args: Parameters<typeof session.prompt>) => session.prompt(...args), inspect: () => session.inspect(), compact: (...args: Parameters<typeof session.compact>) => session.compact(...args), steer: (text: string) => session.steer(text), interrupt: (text?: string) => session.interrupt(text), stop: () => session.stop(), async setModel(model: AgentSessionRequest['model']) { await session.close(); request = { ...request, model }; session = await transport.open(request); }, async close() { try { await session.close(); await transport.close(); } finally { ownedBroker?.close(); store.close(); } } };
  } catch (error) { await transport.close(); ownedBroker?.close(); store.close(); throw error; }
}

export async function testDurableTransport(stateDir: string) {
  await mkdir(stateDir, { recursive: true });
  const store = new TaskStore(join(stateDir, 'durable.sqlite'));
  try {
    const transport = await createDurableSessionTransport(store);
    return { ...transport, async close() { try { await transport.close(); } finally { store.close(); } } };
  } catch (error) { store.close(); throw error; }
}
