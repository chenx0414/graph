// Synthetic paused-gate listener lifecycle probe for 7476f1c.
// No worker is sent; finally cleans up probe-created listeners.
import { mkdtemp, realpath, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import type { Server } from 'node:net';
import { openRestrictedExecutor } from '../../../src/runtime/restricted-process.ts';
import { CallBroker } from '../../../src/runtime/call-broker.ts';
const root = await realpath(await mkdtemp(join(tmpdir(), 'graph-r6-gate-review-')));
const scratchDir = join(root, 'scratch');
await mkdir(scratchDir);
const broker = new CallBroker(join(root, 'state.db'), 'review');
broker.pause();
const executor = await openRestrictedExecutor();
const handles = () => (process as unknown as { _getActiveHandles(): object[] })._getActiveHandles();
const before = new Set(handles());
let leaked: Server[] = [];
try {
  try {
    await executor.run({ broker, cwd: root, scratchDir, executable: process.execPath, args: ['--version'], readPaths: [root, dirname(process.execPath)], writePaths: [root], localNetwork: true, timeoutMs: 1000 });
  } catch (error) { console.log('gate_rejection', String(error)); }
  await new Promise(resolve => setTimeout(resolve, 20));
  leaked = handles().filter(handle => !before.has(handle) && handle.constructor.name === 'Server') as Server[];
  console.log('after_rejection', JSON.stringify({ status: broker.inspect().status, calls: broker.inspect().calls.length, listeners: leaked.map(server => server.address()) }));
  await executor.close();
  await new Promise(resolve => setTimeout(resolve, 20));
  console.log('after_executor_close', JSON.stringify({ listeners: leaked.filter(server => server.listening).length }));
} finally {
  // These handles were created only by this probe; release every one.
  for (const server of leaked) server.close();
  await executor.close();
  broker.close();
  await rm(root, { recursive: true, force: true });
}
