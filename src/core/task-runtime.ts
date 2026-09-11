import { randomUUID } from 'node:crypto';
import { mkdir, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { TaskStore, canonicalJson } from './store.ts';
import { Execution } from './execution.ts';
import { acquireOwner } from './owner.ts';
import { validateProposal } from './proposal.ts';
import { createActivation, loadGraph } from './graph.ts';
import { applyRevision } from './revision.ts';
import { Catalog, type DefinitionSpec } from '../catalog/catalog.ts';
import type { ModelEntry } from '../catalog/models.ts';
import { createPiAdapter } from '../runtime/pi-adapter.ts';
import { invocationRows } from '../runtime/task-gate.ts';
import { CallBroker } from '../runtime/call-broker.ts';
import { openRestrictedExecutor } from '../runtime/restricted-process.ts';
import type { ActionAdapter, Answer, EvidenceInput, Json, Operation, OperationResult } from './types.ts';
import type { OperationRow } from './execution.ts';
import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { RuntimeError, type ProjectConfig, type Proposal, type ProposalReceipt, type Receipt, type NodeSpec, type TaskUpdate, type TaskWatch } from './types.ts';

export async function openTaskRuntime(options: {
  stateDir: string;
  projects?: ProjectConfig[];
  actions?: Record<string, ActionAdapter>;
  models?: { entries: ModelEntry[]; preferences?: Partial<Record<ModelEntry['grade'], string[]>>; apiKey: string; modelRuntime: ModelRuntime };
  master?: { action: string; definitionVersion: string; model: string };
}) {
  await mkdir(options.stateDir, { recursive: true, mode: 0o700 });
  const stateDir = await realpath(options.stateDir);
  const releaseOwner = acquireOwner(join(stateDir, 'owner.sqlite'));
  let store: TaskStore;
  try { store = new TaskStore(join(stateDir, 'tasks.sqlite')); }
  catch (error) { releaseOwner(); throw error; }
  let closed = false;
  let execution: Execution;
  let catalog: Catalog;
  const ensureOpen = () => { if (closed) throw new RuntimeError('closed', 'Runtime is closed'); };
  try {
    store.transaction(() => {
      for (const project of options.projects ?? []) {
        if (!project.id.trim() || !project.root.trim() || project.grants?.some(grant => typeof grant !== 'string' || !grant.trim())) throw new RuntimeError('invalid_input', 'Project identity, root and grants must be nonempty strings');
        const root = resolve(project.root);
        const grants = canonicalJson([...new Set(project.grants ?? [])].sort());
        const previous = store.db.prepare('SELECT root,grants FROM projects WHERE id=?').get(project.id) as { root: string; grants: string } | undefined;
        if (previous && (previous.root !== root || (project.grants !== undefined && previous.grants !== grants))) throw new RuntimeError('project_conflict', 'Persisted project root and base grants cannot change during restore');
        store.db.prepare('INSERT OR IGNORE INTO projects VALUES(?,?,?)').run(project.id, root, grants);
      }
    });
    catalog = new Catalog(store);
    if (options.models) {
      store.transaction(() => {
        for (const entry of options.models!.entries) store.db.prepare('INSERT OR REPLACE INTO models VALUES(?,?)').run(entry.id, canonicalJson(entry));
      });
    }
    const fallback = options.models ? createPiAdapter({
      store, instancesDir: join(stateDir, 'instances'), catalog, directory: () => options.models!.entries,
      apiKey: options.models.apiKey, modelRuntime: options.models.modelRuntime,
    }) : undefined;
    execution = new Execution(store, options.actions ?? {}, {
      ...(fallback ? { fallback } : {}),
      catalog,
      ...(options.models ? { models: () => options.models!.entries } : {}),
      ...(options.models?.preferences ? { preferences: options.models.preferences } : {}),
    });
  } catch (error) {
    try { store.close(); } finally { releaseOwner(); }
    throw error;
  }
  let closing: Promise<void> | undefined;

  const user = {
    async begin(input: { projectId: string; request: string; requestId: string }): Promise<Receipt> {
      ensureOpen();
      return store.command('user', input.requestId, { type: 'begin', projectId: input.projectId, request: input.request }, () => {
        if (!input.request.trim() || !store.db.prepare('SELECT id FROM projects WHERE id=?').get(input.projectId)) throw new RuntimeError('invalid_input', 'A known project and nonempty request are required');
        const taskId = randomUUID();
        const sequence = (store.db.prepare('SELECT COUNT(*) AS count FROM tasks').get() as { count: number }).count + 1;
        store.db.prepare('INSERT INTO tasks(id,project_id,request,created_seq) VALUES(?,?,?,?)').run(taskId, input.projectId, input.request, sequence);
        if (options.master) {
          const spec: NodeSpec = { id: 'master', kind: 'agent', action: options.master.action, definitionVersion: options.master.definitionVersion, model: options.master.model, role: 'master' };
          const instanceId = randomUUID();
          store.db.prepare('INSERT INTO nodes(task_id,id,spec,instance_id) VALUES(?,?,?,?)').run(taskId, spec.id, canonicalJson(spec), instanceId);
          store.db.prepare('INSERT INTO instances(id,task_id,node_id,definition_version,model) VALUES(?,?,?,?,?)').run(instanceId, taskId, spec.id, spec.definitionVersion ?? null, spec.model ?? null);
          createActivation(store, taskId, spec.id, 0);
          const { active_task } = store.db.prepare('SELECT active_task FROM runtime').get() as { active_task: string | null };
          if (!active_task) store.db.prepare('UPDATE runtime SET active_task=?').run(taskId);
        }
        return { taskId, cursor: store.event(taskId, 'task.created', { request: input.request }) };
      });
    },
    task(taskId: string) {
      ensureOpen(); store.task(taskId);
      const setPaused = (paused: boolean, requestId: string): Receipt => {
        ensureOpen();
        return store.command('user', requestId, { type: paused ? 'pause' : 'resume', taskId }, () => {
          store.db.prepare('UPDATE tasks SET paused=? WHERE id=?').run(Number(paused), taskId);
          return { taskId, cursor: store.event(taskId, paused ? 'task.pause_requested' : 'task.resumed', {}) };
        });
      };
      return {
        async pause(requestId: string) { return setPaused(true, requestId); },
        async resume(requestId: string) { return setPaused(false, requestId); },
        async answer(questionId: string, answer: Answer, requestId: string): Promise<Receipt> {
          ensureOpen();
          return store.command('user', requestId, { type: 'answer', taskId, questionId, answer }, () => {
            execution.answer(taskId, questionId, answer);
            return { taskId, cursor: store.event(taskId, 'question.answered', { questionId, answer }) };
          });
        },
        async say(text: string, requestId: string): Promise<Receipt> {
          ensureOpen();
          return store.command('user', requestId, { type: 'say', taskId, text }, () => {
            const task = store.task(taskId);
            if (!text.trim()) throw new RuntimeError('invalid_input', 'A nonempty message is required');
            if (task.accepted_proposal !== null) throw new RuntimeError('requirements_locked', 'Confirmed requirements need an explicit impact review');
            store.db.prepare('UPDATE tasks SET requirement_version=requirement_version+1 WHERE id=?').run(taskId);
            return { taskId, cursor: store.event(taskId, 'requirement.changed', { text, requirementVersion: task.requirement_version + 1 }) };
          });
        },
        async accept(input: { proposalVersion: number; targetBranch: string; requestId: string }): Promise<Receipt> {
          ensureOpen();
          return store.command('user', input.requestId, { type: 'accept', taskId, proposalVersion: input.proposalVersion, targetBranch: input.targetBranch }, () => {
            const task = store.task(taskId);
            const row = store.db.prepare('SELECT requirement_version,spec FROM proposals WHERE task_id=? AND version=?')
              .get(taskId, input.proposalVersion) as { requirement_version: number; spec: string } | undefined;
            if (!row || task.latest_proposal !== input.proposalVersion || row.requirement_version !== task.requirement_version) throw new RuntimeError('stale_proposal', 'Only the current requirement proposal can be accepted');
            if (task.accepted_proposal !== null) throw new RuntimeError('already_accepted', 'Task already has confirmed requirements');
            if (!input.targetBranch.trim()) throw new RuntimeError('invalid_input', 'A target branch is required');
            const proposal = JSON.parse(row.spec) as Proposal;
            store.db.prepare('INSERT INTO graph_revisions(task_id,version,spec,reason,base_version) VALUES(?,?,?,?,?)').run(taskId, 1, row.spec, 'Confirmed task graph', 0);
            for (const node of proposal.nodes) {
              const existing = store.db.prepare('SELECT instance_id FROM nodes WHERE task_id=? AND id=?').get(taskId, node.id) as { instance_id: string | null } | undefined;
              if (existing) {
                store.db.prepare('UPDATE nodes SET spec=?,status=? WHERE task_id=? AND id=?').run(canonicalJson(node), node.kind === 'agent' ? 'pending' : 'pending', taskId, node.id);
                continue;
              }
              const instanceId = node.kind === 'agent' ? randomUUID() : null;
              store.db.prepare('INSERT INTO nodes(task_id,id,spec,instance_id) VALUES(?,?,?,?)').run(taskId, node.id, canonicalJson(node), instanceId);
              if (instanceId) store.db.prepare('INSERT INTO instances(id,task_id,node_id,definition_version,model) VALUES(?,?,?,?,?)').run(instanceId, taskId, node.id, node.definitionVersion ?? null, node.model ?? null);
              createActivation(store, taskId, node.id, 1);
            }
            const { active_task } = store.db.prepare('SELECT active_task FROM runtime').get() as { active_task: string | null };
            const phase = !active_task || active_task === taskId ? 'running' : 'queued';
            store.db.prepare('UPDATE tasks SET accepted_proposal=?,target_branch=?,phase=?,graph_version=1 WHERE id=?')
              .run(input.proposalVersion, input.targetBranch, phase, taskId);
            if (!active_task || active_task === taskId) store.db.prepare('UPDATE runtime SET active_task=?').run(taskId);
            return { taskId, cursor: store.event(taskId, 'task.accepted', { proposalVersion: input.proposalVersion, targetBranch: input.targetBranch }) };
          });
        },
        async view() {
          ensureOpen();
          const task = store.task(taskId);
          const rows = store.db.prepare('SELECT n.id,n.spec,n.instance_id,n.status,n.activation_id,n.output_version,n.stall_count,i.used,i.budget,i.model,i.definition_version FROM nodes n LEFT JOIN instances i ON i.id=n.instance_id WHERE n.task_id=? ORDER BY n.rowid').all(taskId) as { id: string; spec: string; instance_id: string | null; status: string; used: number | null; budget: number | null; activation_id: string; output_version: number; stall_count: number; model: string | null; definition_version: string | null }[];
          const invocations = invocationRows(store, taskId);
          const unknownCost = invocations.some(item => item.cost && typeof item.cost === 'object' && !Array.isArray(item.cost) && item.cost.unknown === true);
          const cost = unknownCost ? { unknown: true as const } : { amount: invocations.reduce((sum, item) => {
            const value = item.cost && typeof item.cost === 'object' && !Array.isArray(item.cost) && typeof item.cost.amount === 'number' ? item.cost.amount : 0;
            return sum + value;
          }, 0) };
          const evidence = store.db.prepare('SELECT node_id,operation_id,proposal_version,requirement_version,data,activation_id,valid FROM evidence WHERE task_id=? ORDER BY rowid').all(taskId) as { node_id: string; operation_id: string; proposal_version: number; requirement_version: number; data: string; activation_id: string; valid: number }[];
          const operations = store.db.prepare('SELECT * FROM operations WHERE task_id=? ORDER BY rowid').all(taskId) as OperationRow[];
          const questions = store.db.prepare('SELECT * FROM questions WHERE task_id=? ORDER BY rowid').all(taskId) as { id: string; node_id: string; operation_id: string | null; kind: string; status: string; data: string; answer: string | null }[];
          const proposal = store.db.prepare('SELECT spec FROM proposals WHERE task_id=? AND version=?').get(taskId, task.latest_proposal) as { spec: string } | undefined;
          const messages = (store.db.prepare("SELECT cursor,type,data FROM events WHERE task_id=? AND type IN ('task.created','requirement.changed') ORDER BY cursor").all(taskId) as { cursor: number; type: string; data: string }[]).map(row => {
            const message = JSON.parse(row.data) as { text?: string; request?: string; requirementVersion?: number };
            return { cursor: row.cursor, text: message.text ?? message.request!, requirementVersion: message.requirementVersion ?? 1 };
          });
          return {
            id: task.id, projectId: task.project_id, request: task.request, requirementVersion: task.requirement_version,
            proposalVersion: task.latest_proposal, acceptedProposalVersion: task.accepted_proposal,
            graphVersion: task.graph_version,
            proposal: proposal ? JSON.parse(proposal.spec) as Proposal : null, messages,
            containers: task.accepted_proposal ? loadGraph(store, taskId).containers() : [],
            targetBranch: task.target_branch, phase: task.phase, paused: Boolean(task.paused),
            status: task.paused ? (operations.some(op => op.worker_active) ? 'pausing' : 'paused') : questions.some(q => q.status === 'open') ? 'blocked' : task.phase,
            operations: operations.map(row => ({ ...JSON.parse(row.spec) as Operation, state: row.state, reserved: row.reserved, workerActive: Boolean(row.worker_active), result: row.result ? JSON.parse(row.result) as OperationResult : null })),
            questions: questions.map(row => ({ id: row.id, nodeId: row.node_id, operationId: row.operation_id, kind: row.kind, status: row.status, data: JSON.parse(row.data) as Json, answer: row.answer ? JSON.parse(row.answer) as Json : null })),
            nodes: rows.map(row => ({ ...JSON.parse(row.spec) as NodeSpec, instanceId: row.instance_id, activationId: row.activation_id, outputVersion: row.output_version, stallCount: row.stall_count, status: row.status, used: row.used, budget: row.budget,
              ...(row.model ? { selectedModel: row.model } : {}), ...(row.definition_version ? { boundDefinition: row.definition_version } : {}),
              reserved: operations.filter(op => op.node_id === row.id).reduce((sum, op) => sum + op.reserved, 0) })),
            evidence: evidence.map(row => ({ ...JSON.parse(row.data) as EvidenceInput, nodeId: row.node_id, operationId: row.operation_id, proposalVersion: row.proposal_version, requirementVersion: row.requirement_version, activationId: row.activation_id, valid: Boolean(row.valid) })),
            invocations, cost,
            cursor: (store.db.prepare('SELECT COALESCE(MAX(cursor),0) AS cursor FROM events').get() as { cursor: number }).cursor,
          };
        },
        watch(after = 0): TaskWatch {
          ensureOpen();
          if (!Number.isSafeInteger(after) || after < 0) throw new RuntimeError('invalid_cursor', 'Invalid event cursor');
          const controller = new AbortController();
          const iterator = (async function* () {
            let cursor = after;
            while (!closed && !controller.signal.aborted) {
              const wake = store.waitForChange(controller.signal);
              const rows = store.db.prepare('SELECT cursor,type,data,timestamp FROM events WHERE task_id=? AND cursor>? ORDER BY cursor LIMIT 100')
                .all(taskId, cursor) as { cursor: number; type: string; data: string; timestamp: number }[];
              if (rows.length) {
                wake.cancel();
                for (const row of rows) {
                  if (controller.signal.aborted) return;
                  cursor = row.cursor;
                  yield { ...row, taskId, data: JSON.parse(row.data) } as TaskUpdate;
                }
              } else { await wake.promise; }
            }
          })();
          return {
            [Symbol.asyncIterator]() { return this; },
            next: () => iterator.next(),
            return: async () => { controller.abort(); return iterator.return(); },
          };
        },
      };
    },
    async list() { ensureOpen(); return store.db.prepare('SELECT id,phase FROM tasks ORDER BY created_seq').all() as { id: string; phase: string }[]; },
  };

  return {
    user,
    host: {
      async runReady() { ensureOpen(); return execution.runReady(); },
      async drive() { ensureOpen(); return execution.drive(); },
      async report(id: string, generation: number, result: OperationResult) { ensureOpen(); execution.report(id, generation, result); },
      async reconcile(id: string) { ensureOpen(); await execution.reconcile(id); },
    },
    supervisor(taskId: string) {
      ensureOpen(); store.task(taskId);
      // Give workers this scoped object, never the user or host runtime object.
      return {
        async propose(proposal: Proposal, requestId: string): Promise<ProposalReceipt> {
          ensureOpen();
          return store.command(`supervisor:${taskId}`, requestId, { type: 'propose', proposal }, () => {
            const task = store.task(taskId);
            if (task.accepted_proposal !== null) throw new RuntimeError('requirements_locked', 'Confirmed task scope is immutable in M1');
            if (task.requirement_version !== proposal.requirementVersion) throw new RuntimeError('stale_requirement', 'Proposal uses an old requirement version');
            validateProposal(proposal);
            const version = task.latest_proposal + 1;
            store.db.prepare('INSERT INTO proposals VALUES(?,?,?,?)').run(taskId, version, proposal.requirementVersion, canonicalJson(proposal));
            store.db.prepare('UPDATE tasks SET latest_proposal=? WHERE id=?').run(version, taskId);
            return { taskId, proposalVersion: version, cursor: store.event(taskId, 'proposal.created', { proposalVersion: version }) };
          });
        },
        async revise(input: { baseVersion: number; reason: string; nodes: NodeSpec[]; containers?: Proposal['containers']; loops?: Proposal['loops']; requestId: string }) {
          ensureOpen();
          return store.command(`supervisor:${taskId}`, input.requestId, { type: 'revise', baseVersion: input.baseVersion, reason: input.reason, nodes: input.nodes, containers: input.containers, loops: input.loops }, () => {
            const revised = applyRevision(store, taskId, { baseVersion: input.baseVersion, reason: input.reason, nodes: input.nodes, ...(input.containers ? { containers: input.containers } : {}), ...(input.loops ? { loops: input.loops } : {}) });
            return { taskId, graphVersion: revised.version, cursor: revised.cursor };
          });
        },
      };
    },
    catalog: {
      publishDefinition(id: string, spec: DefinitionSpec, requestId: string) {
        ensureOpen();
        return store.command('catalog', requestId, { type: 'publish', id, spec }, () => catalog.publishDefinition(id, spec));
      },
      definitions() { ensureOpen(); return catalog.listDefinitions(); },
      capability(id: string) { ensureOpen(); return catalog.capability(id); },
      async install(input: { id: string; kind: 'skill' | 'mcp' | 'extension'; source: string; version: string; requestId: string }) {
        ensureOpen();
        const payload = { type: 'install', id: input.id, kind: input.kind, source: input.source, version: input.version };
        const encoded = canonicalJson(payload);
        const previous = store.db.prepare('SELECT payload,receipt FROM commands WHERE scope=? AND request_id=?').get('catalog', input.requestId) as { payload: string; receipt: string } | undefined;
        if (previous) {
          if (previous.payload !== encoded) throw new RuntimeError('idempotency_conflict', 'requestId was already used with different content');
          return JSON.parse(previous.receipt) as { id: string; version: string; path: string };
        }
        const installationId = randomUUID();
        const dest = join(stateDir, 'capabilities', input.id, input.version);
        store.transaction(() => store.db.prepare('INSERT INTO installations VALUES(?,?,?,?,?)').run(installationId, input.id, 'intent', canonicalJson(input), null));
        const broker = new CallBroker(join(stateDir, 'install-calls.sqlite'), 'installer');
        try {
          const parent = join(stateDir, 'capabilities', input.id);
          await mkdir(parent, { recursive: true, mode: 0o700 });
          const source = await realpath(input.source);
          const grant = await realpath(parent);
          store.db.prepare("UPDATE installations SET state='dispatched' WHERE id=?").run(installationId);
          try { await realpath(dest); }
          catch {
            const executor = await openRestrictedExecutor();
            try {
              const result = await executor.run({
                broker, cwd: source, scratchDir: grant, executable: '/bin/cp', args: ['-R', source, dest],
                readPaths: [source], writePaths: [grant],
              });
              if (result.code !== 0) throw new RuntimeError('install_failed', result.stderr || 'Capability install failed');
            } finally { await executor.close(); }
          }
          const snapshot = { path: dest, copied: true };
          const receipt = { id: input.id, version: input.version, path: dest };
          store.transaction(() => {
            catalog.recordInstall({ id: input.id, kind: input.kind, source: input.source, version: input.version, snapshot, status: 'installed' });
            store.db.prepare("UPDATE installations SET state='succeeded',result=? WHERE id=?").run(canonicalJson(snapshot), installationId);
            store.db.prepare('INSERT INTO commands VALUES(?,?,?,?)').run('catalog', input.requestId, encoded, canonicalJson(receipt));
          });
          return receipt;
        } catch (error) {
          store.db.prepare("UPDATE installations SET state='unknown',result=? WHERE id=?").run(String(error), installationId);
          throw error;
        } finally { broker.close(); }
      },
      async reconcileInstall(id: string) {
        ensureOpen();
        const row = store.db.prepare('SELECT * FROM installations WHERE capability_id=? ORDER BY rowid DESC LIMIT 1').get(id) as { id: string; state: string; spec: string } | undefined;
        if (!row || row.state === 'succeeded') return catalog.capability(id);
        const spec = JSON.parse(row.spec) as { source: string; version: string; kind: 'skill' | 'mcp' | 'extension' };
        return this.install({ id, kind: spec.kind, source: spec.source, version: spec.version, requestId: `reconcile-${row.id}` });
      },
    },
    close() {
      if (!closing) {
        closed = true;
        closing = (async () => { await execution.drain(); try { store.close(); } finally { releaseOwner(); } })();
      }
      return closing;
    },
  };
}
