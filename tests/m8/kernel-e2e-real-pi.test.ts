import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { TaskStore } from '../../src/core/store.ts';
import { KernelStore } from '../../src/core/kernel-store.ts';
import { parseGraphDefinition } from '../../src/core/interface-spec.ts';
import { graphAcceptance } from '../../src/core/graph-acceptance.ts';

// The real submit -> delivery -> reopened public view proof is owned by
// graph-completion-e2e.test.ts. This separate acceptance contract retains the
// unknown-call budget distinction formerly mixed into that E2E.
test('acceptance holds unknown calls for finite budgets and all inflight calls without treating unknown usage as zero', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-unknown-acceptance-'));
  const store = new TaskStore(join(root, 'tasks.sqlite'));
  try {
    store.db.prepare('INSERT INTO projects(id,root,grants) VALUES(?,?,?)').run('p', root, '[]');
    store.db.prepare('INSERT INTO tasks(id,project_id,request,requirement_version,latest_proposal,phase,paused,created_seq) VALUES(?,?,?,1,0,?,0,1)').run('g1', 'p', 'r', 'running');
    const kernel = new KernelStore(store);
    const revision = kernel.publishRevision('g1', { definition: parseGraphDefinition({ schemaVersion: 2, name: 'unknown-call', protocols: {},
      nodes: { a: { recipe: 'a@1', task: 'inspect usage', inputs: {}, outputs: {}, submission: {} } }, modules: {}, edges: {} }), reason: 'create' });
    kernel.admitNode('g1', revision.version, 'a', { instanceId: 'i-a' });
    kernel.setNodeQueuePaused('g1', 'a', false);
    store.db.prepare('INSERT INTO kernel_provider_calls(id,task_id,node_id,execution_id,reserved,state,created_at) VALUES(?,?,?,?,?,?,?)')
      .run('call-unknown', 'g1', 'a', 'interrupted-execution', 1000, 'unknown', Date.now());
    store.db.prepare("UPDATE kernel_node_state SET authorized_budget=1000000 WHERE task_id='g1' AND node_id='a'").run();
    expect(graphAcceptance(kernel, 'g1').drained).toBe(false);
    store.db.prepare("UPDATE kernel_node_state SET authorized_budget=NULL WHERE task_id='g1' AND node_id='a'").run();
    expect(graphAcceptance(kernel, 'g1').drained).toBe(true);
    expect(kernel.providerCalls('g1', 'a')[0]).toMatchObject({ state: 'unknown', usage: null });
    store.db.prepare("UPDATE kernel_provider_calls SET state='inflight' WHERE id='call-unknown'").run();
    expect(graphAcceptance(kernel, 'g1').drained).toBe(false);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});
