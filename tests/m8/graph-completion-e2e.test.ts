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
import { hostSubmitCall } from '../../src/core/node-submit-bridge.ts';
import { GraphLane } from '../../src/core/graph-lane.ts';
import { ResidentHost } from '../../src/runtime/resident-host.ts';
import { parseGraphDefinition } from '../../src/core/interface-spec.ts';
import { graphAcceptance } from '../../src/core/graph-acceptance.ts';

/**
 * Issue #1 §14 — "a real graph runs to completion", through the public interface, with the
 * strongest evidence the specification names: a REAL Pi process per node, a controlled
 * model, and a real on-disk SQLite kernel.
 *
 * The pieces were proven one at a time (delivery, routing, the runner, the lane). §14 asks
 * for the composition: a graph that finishes because a real process submitted, the kernel
 * routed the delivery, and the next node ran because of it — not because a test called the
 * next step.
 *
 * This drives the production lane with nothing faked between the parts:
 *   create a real v2 graph on disk → queue the first node → GraphLane.runnable() names it →
 *   a real ResidentHost spawns the real worker for node a → the node calls `submit` →
 *   the call crosses the process boundary and lands in the kernel → the delivery queues
 *   node b → the lane spawns b's own worker → b submits → the graph drains empty.
 *
 * The only scripted part is the model's replies, which is what "controlled model" means.
 */

const workerEntry = fileURLToPath(new URL('../../src/runtime/resident-worker-entry.ts', import.meta.url));
const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const action of cleanup.reverse()) await Promise.resolve(action()).catch(() => undefined);
  cleanup.length = 0;
});

const DEF = parseGraphDefinition({
  schemaVersion: 2, name: 'real-completion',
  protocols: { ping: { type: 'object', required: ['n'], properties: { n: { type: 'number' } } } },
  nodes: {
    a: { recipe: 'a@1', task: 'produce a number', inputs: {}, outputs: { out: { protocol: 'ping' } }, submission: { required: ['out'] } },
    b: { recipe: 'b@1', task: 'receive the number', inputs: { in: { protocol: 'ping' } }, outputs: { done: { protocol: 'ping' } }, submission: { required: ['done'] } },
  },
  modules: {},
  edges: { e: { from: 'a.out', to: 'b.in', enabled: true } },
});

describe('§14 E2E — a real v2 graph runs to completion through the lane', () => {
  test('a submits, the delivery queues b, b submits by its own real process, and the graph drains', async () => {
    // The controlled model serves both nodes in order: a submits 42, then b submits 43.
    const provider = await openaiServer([
      // a's first call puts its output somewhere other than `outputs` — the exact shape a real
      // node repeated 493 times on 2026-09-27. The refusal has to name the argument, because a
      // model that reads "out was not enabled" believes it already enabled out and repeats.
      { tools: [{ id: 'c1', name: 'submit', arguments: JSON.stringify({ verdict: { outputs: { out: { enable: true, value: { n: 42 } } } } }) }], finishReason: 'tool_calls' },
      { tools: [{ id: 'c2', name: 'submit', arguments: JSON.stringify({ outputs: { out: { enable: true, value: { n: 42 } } } }) }], finishReason: 'tool_calls' },
      { text: 'a done.' },
      { tools: [{ id: 'c3', name: 'submit', arguments: JSON.stringify({ outputs: { done: { enable: true, value: { n: 43 } } } }) }], finishReason: 'tool_calls' },
      { text: 'b done.' },
    ]);
    cleanup.push(() => provider.close());

    const dir = await realpath(await mkdtemp(join(tmpdir(), 'graph-complete-')));
    cleanup.push(() => rm(dir, { recursive: true, force: true }));
    const workspace = join(dir, 'workspace');
    await mkdir(workspace, { recursive: true });
    // Each node keeps its own session lineage, so each needs its own state directory (§7).
    await mkdir(join(dir, 'state', 'a'), { recursive: true });
    await mkdir(join(dir, 'state', 'b'), { recursive: true });

    // A real on-disk kernel — exactly the one confirmation creates (§13.8 switchover).
    const store = new TaskStore(join(dir, 'tasks.sqlite'));
    cleanup.push(() => store.close());
    store.db.exec(`INSERT INTO projects(id,root,grants) VALUES('p','${dir}','[]');`);
    const kernel = new KernelStore(store);
    store.db.prepare('INSERT INTO tasks(id,project_id,request,requirement_version,latest_proposal,phase,paused,created_seq) VALUES(?,?,?,1,0,?,0,1)').run('g1', 'p', 'r', 'running');
    const rev = kernel.publishRevision('g1', { definition: DEF, reason: 'create' });
    for (const nodeId of ['a', 'b']) kernel.admitNode('g1', rev.version, nodeId, { instanceId: `i-${nodeId}` });

    // Queue the first node, exactly as an external input would.
    new NodeQueue(kernel, 'g1').enqueue({ nodeId: 'a', kind: 'delivery', input: 'in', value: { go: true } as never });

    // One real host per node, exactly as §7 requires: the lane asks for a host per node, and
    // this spawns a real resident worker whose submit crosses the process boundary.
    // Every tool result the nodes saw, so the refusal's own words can be asserted.
    const seen: { node: string; text: string }[] = [];
    const hosts = new Map<string, ResidentHost>();
    const hostFor = (nodeId: string) => {
      const host = new ResidentHost({
        workerEntry,
        cwd: workspace,
        configPath: join(dir, `worker-${nodeId}.json`),
        config: {
          binding: { instanceId: `i-${nodeId}`, nodeId, definitionVersion: `${nodeId}@1` },
          workspace,
          stateDir: join(dir, 'state', nodeId),
          model: provider.model,
          thinkingLevel: 'off',
          tools: [{ name: 'submit', label: 'Submit', description: 'Submit the node result', parameters: { type: 'object' } as never }],
          nativeTools: [], skillPaths: [], piExtensionPaths: [], piExtensionTools: [],
          systemPrompt: 'Submit the required output when the work is done.',
          allowedToolNames: ['submit'],
          bundleDigest: 'e2e-bundle', toolPolicyDigest: 'e2e-tools', runtimePolicyDigest: 'e2e-runtime',
        },
        // The host owns the submit: it runs the production path itself, not a copy of it. The copy
        // that used to live here drifted (it read `args.outputs` while production read
        // `args.outputs ?? {}`), and that drift is why the malformed-argument defect had no test.
        onToolCall: (name, args) => {
          if (name !== 'submit') return { ok: false, text: `the host does not offer a tool named ${name}` };
          const result = hostSubmitCall(kernel, 'g1', nodeId, args);
          seen.push({ node: nodeId, text: result.text });
          return result;
        },
      });
      cleanup.push(() => host.stop());
      hosts.set(nodeId, host);
      return host;
    };

    const lane = new GraphLane({
      kernel,
      host: async (_graphId: string, nodeId: string) => hostFor(nodeId),
      config: () => ({}),
      initialContext: (_graphId, nodeId) => `Graph node ${nodeId}. Submit the required output.`,
    });

    // The lane names the graph because it has queued work, and running it drains the graph.
    const runnable = lane.runnable();
    expect(runnable.map(g => g.taskId)).toEqual(['g1']);
    const result = await runnable[0]!.run();

    // 1. The graph drained: nothing queued, no node left paused.
    expect(result.drained).toBe(true);
    expect(kernel.nextQueued('g1', 'a')).toBeNull();
    expect(kernel.nextQueued('g1', 'b')).toBeNull();

    // 2. Both nodes really ran, each with its own execution and its own resident process.
    const aExec = store.db.prepare("SELECT COUNT(*) AS n FROM kernel_executions WHERE task_id='g1' AND node_id='a'").get() as { n: number };
    const bExec = store.db.prepare("SELECT COUNT(*) AS n FROM kernel_executions WHERE task_id='g1' AND node_id='b'").get() as { n: number };
    expect(aExec.n).toBe(1);
    expect(bExec.n).toBe(1);
    expect(hosts.get('a')!.spawnCount()).toBe(1);
    expect(hosts.get('b')!.spawnCount()).toBe(1);
    // b's process is a different process from a's: one resident worker per node (§7).
    expect((await hosts.get('a')!.inspect()).processId).not.toBe((await hosts.get('b')!.inspect()).processId);

    // 3. The delivery from a to b is on disk — the reason b ran at all.
    const delivery = store.db.prepare("SELECT to_endpoint, value FROM kernel_deliveries WHERE task_id='g1'").get() as { to_endpoint: string; value: string } | undefined;
    expect(delivery?.to_endpoint).toBe('b.in');
    expect(JSON.parse(delivery!.value)).toEqual({ n: 42 });

    // 4. Real model turns crossed the HTTP boundary, for both nodes.
    expect(provider.requests.length).toBeGreaterThanOrEqual(2);

    // 5. An interrupted provider call is a hold only where it really is one. A node with no token
    // cap keeps usage:null / 'unknown' by design and may still commit, so such a call must not pin
    // the graph as undrained — that is what made an accepted graph undeliverable on 2026-09-27.
    // A finite node still holds, and an inflight call always does.
    store.db.prepare('INSERT INTO kernel_provider_calls(id,task_id,node_id,execution_id,reserved,state,created_at) VALUES(?,?,?,?,?,?,?)')
      .run('call-unknown', 'g1', 'a', 'exec-gone', 1000, 'unknown', Date.now());
    expect(graphAcceptance(kernel, 'g1').drained).toBe(false);
    // The instance row is synthetic: instances also references the legacy nodes table, which this
    // kernel never uses, so foreign keys are off for this one fixture row only.
    store.db.exec('PRAGMA foreign_keys=OFF;');
    store.db.prepare("INSERT INTO instances(id,task_id,node_id,budget,used,definition_version,model,models_used,unlimited) VALUES('i-a','g1','a',0,0,'a@1','m','[]',1)").run();
    store.db.exec('PRAGMA foreign_keys=ON;');
    expect(graphAcceptance(kernel, 'g1').drained).toBe(true);
    store.db.prepare("UPDATE kernel_provider_calls SET state='inflight' WHERE id='call-unknown'").run();
    expect(graphAcceptance(kernel, 'g1').drained).toBe(false);

    // 5. A call that carries no `outputs` object is refused for its ARGUMENT SHAPE, not told
    // that its output was not enabled. A model can only correct what the refusal names, and
    // "out (missing_required_output): expected enable:true" reads as "enable out" to a model
    // that already believes it did — that misreading is what repeated 493 times.
    const first = seen.find(entry => entry.node === 'a')!;
    expect(first.text).toContain('submit refused');
    expect(first.text).toContain('outputs');
    expect(first.text).not.toContain('missing_required_output');

    // 6. The malformed call did not consume the one valid submission: a still submitted 42.
    expect(seen.filter(entry => entry.node === 'a' && entry.text.includes('"accepted":true')).length).toBe(1);
  }, 60_000);
});
