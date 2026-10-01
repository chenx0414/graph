import { describe, expect, test } from 'vitest';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach } from 'vitest';
import { openaiServer } from '../fixtures/openai-server.ts';
import { TaskStore } from '../../src/core/store.ts';
import { KernelStore } from '../../src/core/kernel-store.ts';
import { NodeQueue } from '../../src/core/node-queue.ts';
import { NodeSubmitBridge } from '../../src/core/node-submit-bridge.ts';
import { NodeExecutor } from '../../src/core/node-executor.ts';
import { NodeTurnDriver } from '../../src/core/node-turn-driver.ts';
import { ResidentHost } from '../../src/runtime/resident-host.ts';
import { parseGraphDefinition } from '../../src/core/interface-spec.ts';

/**
 * Issue #1 §14 — behaviour verified through the public interface, with the strongest
 * evidence the specification names: a REAL Pi process, a controlled model, and a real
 * on-disk SQLite task store. §14 is explicit that a screenshot proves layout and nothing
 * about scheduling, and that a contract must be shown rather than asserted.
 *
 * What this proves end to end, with nothing faked in the middle:
 *
 *   1. a real `ResidentHost` spawns the real resident worker as its own OS process;
 *   2. the scripted model decides to call the `submit` tool;
 *   3. the call crosses the process boundary to the host (HB-262);
 *   4. the host runs `NodeSubmitBridge` against a REAL execution in a REAL SQLite kernel;
 *   5. the kernel's Submission and Delivery are on disk, and the queue is drained;
 *   6. the model receives the host's answer and finishes the turn.
 *
 * The only scripted parts are the model's replies, which is what "controlled model"
 * means in §14.
 */

const workerEntry = fileURLToPath(new URL('../../src/runtime/resident-worker-entry.ts', import.meta.url));
const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const action of cleanup.reverse()) await Promise.resolve(action()).catch(() => undefined);
  cleanup.length = 0;
});

const DEF = parseGraphDefinition({
  schemaVersion: 2, name: 'real-node',
  protocols: { ping: { type: 'object', required: ['n'], properties: { n: { type: 'number' } } } },
  nodes: {
    a: { recipe: 'a@1', task: 'produce a number', inputs: {}, outputs: { out: { protocol: 'ping' } }, submission: { required: ['out'] } },
    b: { recipe: 'b@1', task: 'b', inputs: { in: { protocol: 'ping' } }, outputs: {}, submission: {} },
  },
  modules: {},
  edges: { e: { from: 'a.out', to: 'b.in', enabled: true } },
});

describe('§14 E2E — a real Pi process drives a real execution into a real kernel', () => {
  test('the node calls submit, the host executes it, and the delivery is on disk', async () => {
    // The controlled model: first it calls `submit`; then it answers.
    const provider = await openaiServer([
      {
        tools: [{ id: 'c1', name: 'submit', arguments: JSON.stringify({ outputs: { out: { enable: true, value: { n: 42 } } } }) }],
        finishReason: 'tool_calls',
      },
      { text: 'Done and submitted.' },
    ]);
    cleanup.push(() => provider.close());

    const dir = await realpath(await mkdtemp(join(tmpdir(), 'graph-e2e-')));
    cleanup.push(() => rm(dir, { recursive: true, force: true }));
    const workspace = join(dir, 'workspace');
    const stateDir = join(dir, 'state');
    const configPath = join(dir, 'worker.json');
    await mkdir(workspace, { recursive: true });
    await mkdir(stateDir, { recursive: true });

    // A real on-disk task store and kernel: the evidence must be on disk (§14).
    const store = new TaskStore(join(dir, 'state.db'));
    cleanup.push(() => store.close());
    store.db.exec(`
      INSERT INTO projects(id,root,grants) VALUES('p','${dir}','[]');
      INSERT INTO tasks(id,project_id,request,requirement_version,latest_proposal,phase,paused,created_seq)
        VALUES('g1','p','r',1,0,'executing',0,1);
    `);
    const kernel = new KernelStore(store);
    const rev = kernel.publishRevision('g1', { definition: DEF, reason: 'create' });
    kernel.admitNode('g1', rev.version, 'a', { instanceId: 'i-a' });
    kernel.admitNode('g1', rev.version, 'b', { instanceId: 'i-b' });

    // The node's one queued item: this is what the executor will drain.
    new NodeQueue(kernel, 'g1').enqueue({ nodeId: 'a', kind: 'delivery', input: 'in', value: { go: true } as never });

    // The REAL host, spawning the REAL worker entry as its own process.
    const host = new ResidentHost({
      workerEntry,
      cwd: workspace,
      configPath,
      config: {
        binding: { instanceId: 'i-a', nodeId: 'a', definitionVersion: 'a@1' },
        workspace,
        stateDir,
        model: provider.model,
        thinkingLevel: 'off',
        tools: [{ name: 'submit', label: 'Submit', description: 'Submit the node result', parameters: { type: 'object' } as never }],
        nativeTools: [],
        skillPaths: [],
        piExtensionPaths: [],
        piExtensionTools: [],
        systemPrompt: 'Submit the required output when the work is done.',
        allowedToolNames: ['submit'],
        bundleDigest: 'e2e-bundle',
        toolPolicyDigest: 'e2e-tools',
        runtimePolicyDigest: 'e2e-runtime',
      },
      // The host owns the submit: it binds the real execution and writes the real kernel.
      onToolCall: (name, args) => {
        if (name !== 'submit') return { ok: false, text: `the host does not offer a tool named ${name}` };
        const execution = kernel.db.prepare("SELECT id FROM kernel_executions WHERE task_id='g1' ORDER BY rowid DESC LIMIT 1").get() as { id: string } | undefined;
        if (!execution) return { ok: false, text: 'no execution is running for this node' };
        const bridge = new NodeSubmitBridge(kernel, execution.id);
        const request = args as { outputs: Record<string, { enable?: boolean; value?: unknown }> };
        const receipt = bridge.submit({ outputs: request.outputs, submissionId: `s-${execution.id}` });
        return receipt.accepted
          ? { ok: true, text: JSON.stringify({ accepted: true, deliveries: receipt.deliveries.length }) }
          : { ok: false, text: bridge.refusalMessage(receipt) };
      },
    });
    cleanup.push(() => host.stop());
    await host.start();

    // The production driver, over the production host.
    const driver = new NodeTurnDriver({
      kernel, graphId: 'g1', nodeId: 'a', host,
      initialContext: () => 'Graph node a. Task: produce a number and submit the required output.',
      submit: (executionId) => {
        const bridge = new NodeSubmitBridge(kernel, executionId);
        return { missing: bridge.submit({ outputs: {}, submissionId: `j-${executionId}` }).missingRequired };
      },
    });
    const executor = new NodeExecutor({ kernel, graphId: 'g1', host, workerEntry, config: {} as never, cwd: workspace, configPath });

    const outcome = await executor.runNode('a', (executionId, attempt, injection) => driver.run(executionId, attempt, injection));

    // 1. The queue was drained by the real path.
    expect(outcome).toBe('done');
    expect(kernel.nextQueued('g1', 'a')).toBeNull();

    // 2. The submission and its delivery are in the kernel — and on disk.
    const execution = kernel.db.prepare("SELECT id, state FROM kernel_executions WHERE task_id='g1' ORDER BY rowid DESC LIMIT 1").get() as { id: string; state: string };
    const deliveries = kernel.deliveriesFor(execution.id);
    expect(deliveries.length).toBe(1);
    expect(deliveries[0]!.toEndpoint).toBe('b.in');
    expect(deliveries[0]!.value).toEqual({ n: 42 });
    expect(execution.state).toBe('completed');

    // 3. The delivery is a row in the on-disk database, not only in memory.
    const row = store.db.prepare('SELECT value, to_endpoint FROM kernel_deliveries WHERE task_id=?').get('g1') as { value: string; to_endpoint: string };
    expect(JSON.parse(row.value)).toEqual({ n: 42 });
    expect(row.to_endpoint).toBe('b.in');

    // 4. Two real model turns crossed the HTTP boundary through the real process.
    expect(provider.requests.length).toBe(2);
    expect(host.spawnCount()).toBe(1);
  }, 60_000);
});
