import { wakeMaster, wakeForTaskCompleted } from './wake-ledger.ts';
import { createHash, randomUUID } from 'node:crypto';
import type { ArtifactWorkspace } from './artifact-workspace.ts';
import { canonicalJson } from './store.ts';
import { graphAcceptance } from './graph-acceptance.ts';
import { insertQuestion } from './question-routing.ts';
import { RuntimeError, type Json } from './types.ts';
import type { KernelStore, QueueRow } from './kernel-store.ts';
import { NodeQueue } from './node-queue.ts';
import { parseGraphDefinition, type GraphDefinition } from './interface-spec.ts';

/**
 * Graph lifecycle and the main agent's control surface (Issue #1 §5, §8).
 *
 * A graph is distinct from its definition: `create` turns a definition into a
 * graph with an immutable revision; `patch` produces a NEW revision and never
 * mutates one that already exists. This module owns the eight phases the spec
 * names — running, idle, paused, completing, completed, stopping, stopped, blocked
 * — and the two gates that matter most:
 *
 *   - while `completing`, EXTERNAL task delivery and execution-triggering chat are
 *     refused with a `completing` error, while internal work may still produce
 *     follow-on; a completion request can be withdrawn to restore external input;
 *   - `stop` cancels the queue and blocks new dispatch, then settles as `stopped`.
 *
 * Completion settles only when the queue, in-flight executions and pending module
 * transitions are all drained AND no failure is unresolved. `blocked` is NOT
 * drained: a failed node keeps its evidence until the main agent handles it.
 */

export type GraphPhase =
  | 'running' | 'idle' | 'paused' | 'completing' | 'completed' | 'stopping' | 'stopped' | 'blocked';

export interface GraphStateRow {
  graphId: string;
  phase: GraphPhase;
  revision: number;
}

export interface PatchChange {
  reason: string;
  definition?: GraphDefinition;
  /** JSON merge patch: named objects merge, arrays replace, null removes a field. */
  patch?: Json;
  /** Node ids to retire explicitly; every omitted node must be named here (§8). */
  retire?: string[];
}

export interface CreatedGraph {
  graphId: string;
  definition: GraphDefinition;
  revision: { version: number };
}

/** Apply a JSON merge patch to a copy; keys never mutate object prototypes. */
function patchedDefinition(definition: GraphDefinition, input: Json): unknown {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new RuntimeError('invalid_input', 'Graph patch must be a JSON object');
  let patch: Record<string, Json>;
  try { patch = JSON.parse(JSON.stringify(input)) as Record<string, Json>; }
  catch { throw new RuntimeError('invalid_input', 'Graph patch must contain serializable JSON'); }
  const result = structuredClone(definition) as unknown as Record<string, Json>;
  const pending = [{ target: result, patch }];
  while (pending.length) {
    const { target, patch } = pending.pop()!;
    for (const [key, value] of Object.entries(patch)) {
      if (value === null) { delete target[key]; continue; }
      if (typeof value === 'object' && !Array.isArray(value)) {
        const current = Object.hasOwn(target, key) ? target[key] : undefined;
        const nested = current && typeof current === 'object' && !Array.isArray(current) ? current : {};
        Object.defineProperty(target, key, { value: nested, enumerable: true, writable: true, configurable: true });
        pending.push({ target: nested, patch: value });
      } else Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
    }
  }
  return result;
}

export class GraphRuntime {
  private readonly kernel: KernelStore;
  private readonly graphId: string;
  private readonly artifacts: ArtifactWorkspace | undefined;

  constructor(kernel: KernelStore, graphId: string, artifacts?: ArtifactWorkspace) {
    this.kernel = kernel;
    this.graphId = graphId;
    this.artifacts = artifacts;
  }

  private taskRow(): { id: string } | undefined {
    return this.kernel.db.prepare('SELECT id FROM tasks WHERE id=?').get(this.graphId) as { id: string } | undefined;
  }

  private ensureTask(): void {
    if (!this.taskRow()) {
      throw new RuntimeError('invalid_graph', `Graph ${this.graphId} does not exist; call create first`);
    }
  }

  /** §5: create validates the whole definition and produces a graph plus its first revision. */
  create(definition: GraphDefinition, options: { request?: string; projectId?: string } = {}): CreatedGraph {
    // Whole-or-nothing: a bad definition must not leave a graph behind.
    const parsed = parseGraphDefinition(definition);
    const projectId = options.projectId ?? 'p1';
    return this.kernel.store.transaction(() => {
      if (this.taskRow()) throw new RuntimeError('invalid_graph', `Graph ${this.graphId} already exists`);
      this.kernel.store.db.prepare('INSERT INTO tasks(id,project_id,request,requirement_version,latest_proposal,created_seq,phase) VALUES(?,?,?,?,?,?,?)')
        .run(this.graphId, projectId, options.request ?? parsed.name, 1, 0, Date.now(), 'running');
      const revision = this.kernel.insertRevision(this.graphId, parsed, 'create');
      return { graphId: this.graphId, definition: parsed, revision: { version: revision.version } };
    });
  }

  /** §5, §8: patch requires a base revision; a conflict returns the current version and changes nothing. */
  patch(input: { baseRevision: number; changes: PatchChange }): { revision: number } {
    this.ensureTask();
    if (['completed', 'stopping', 'stopped'].includes(this.state()!.phase)) throw new RuntimeError('invalid_graph', 'Ended graph cannot be patched');
    const latest = this.kernel.latestRevision(this.graphId);
    if (!latest) throw new RuntimeError('invalid_graph', `Graph ${this.graphId} has no revision to patch`);
    if (latest.version !== input.baseRevision) {
      // Zero partial change: the caller is told the current version and must retry.
      throw new RuntimeError('stale_revision', `Patch is based on revision ${input.baseRevision} but the current revision is ${latest.version}`);
    }
    if (typeof input.changes.reason !== 'string' || !input.changes.reason.trim()) throw new RuntimeError('invalid_input', 'Graph change requires a reason');
    if ((input.changes.definition !== undefined) === (input.changes.patch !== undefined)) throw new RuntimeError('invalid_input', 'Supply exactly one full definition or local patch');
    // Both update forms produce the same formal definition and validate before writing.
    const parsed = parseGraphDefinition(input.changes.patch === undefined ? input.changes.definition
      : patchedDefinition(latest.definition, input.changes.patch));
    if (latest.definition.acceptance?.length && canonicalJson(parsed.acceptance ?? []) !== canonicalJson(latest.definition.acceptance)) {
      throw new RuntimeError('invalid_input', 'Patch cannot change declared final acceptance');
    }
    if (input.changes.retire?.length) {
      for (const id of input.changes.retire) {
        if (!latest.definition.nodes[id] && !latest.definition.modules[id]) {
          throw new RuntimeError('invalid_graph', `Retire names unknown node or module ${id}`);
        }
      }
    }
    return this.kernel.store.transaction(() => {
      const removed = [...Object.keys(latest.definition.nodes), ...Object.keys(latest.definition.modules)]
        .filter(id => !parsed.nodes[id] && !parsed.modules[id]);
      for (const id of removed) {
        if (!input.changes.retire?.includes(id)) throw new RuntimeError('invalid_graph', `Removing ${id} requires explicit retire`);
        const pending = this.kernel.db.prepare("SELECT 1 FROM kernel_queue WHERE task_id=? AND node_id=? AND state IN ('queued','claimed','failed') LIMIT 1").get(this.graphId, id);
        const inbox = this.kernel.db.prepare('SELECT 1 FROM kernel_module_inbox WHERE task_id=? AND module_id=? AND processed=0 LIMIT 1').get(this.graphId, id);
        const running = this.kernel.db.prepare("SELECT 1 FROM kernel_executions WHERE task_id=? AND node_id=? AND state='running' LIMIT 1").get(this.graphId, id);
        const outbox = this.kernel.db.prepare('SELECT 1 FROM kernel_transition_outbox o JOIN kernel_module_transitions t ON t.id=o.transition_id WHERE t.task_id=? AND t.module_id=? AND o.routed=0 LIMIT 1').get(this.graphId, id);
        if (pending || inbox || running || outbox) throw new RuntimeError('pending_work', `Cannot remove ${id}: settle or explicitly cancel its pending work first`);
      }
      const revision = this.kernel.insertRevision(this.graphId, parsed, input.changes.reason);
      for (const [id, node] of Object.entries(parsed.nodes)) {
        if (!latest.definition.nodes[id]) this.kernel.admitNode(this.graphId, revision.version, id, { instanceId: randomUUID() });
        else this.kernel.db.prepare('UPDATE kernel_nodes SET revision_version=?,spec=? WHERE task_id=? AND node_id=?')
          .run(revision.version, JSON.stringify(node), this.graphId, id);
      }
      for (const [id, module] of Object.entries(parsed.modules)) {
        if (!latest.definition.modules[id]) this.kernel.admitModule(this.graphId, revision.version, id, { moduleType: module.type, trigger: module.trigger });
        else this.kernel.db.prepare('UPDATE kernel_modules SET revision_version=?,module_type=?,trigger=? WHERE task_id=? AND module_id=?')
          .run(revision.version, module.type, module.trigger, this.graphId, id);
      }
      for (const id of removed) this.kernel.db.prepare("UPDATE kernel_nodes SET status='retired' WHERE task_id=? AND node_id=?").run(this.graphId, id);
      return { revision: revision.version };
    });
  }

  state(): GraphStateRow | null {
    const row = this.kernel.db.prepare('SELECT phase,paused FROM tasks WHERE id=?').get(this.graphId) as { phase: string; paused: number } | undefined;
    if (!row) return null;
    const latest = this.kernel.latestRevision(this.graphId);
    const phase = row.paused && !['completed', 'stopping', 'stopped'].includes(row.phase) ? 'paused' : row.phase as GraphPhase;
    return { graphId: this.graphId, phase, revision: latest?.version ?? 0 };
  }

  private setPhase(phase: GraphPhase): void {
    this.kernel.store.db.prepare('UPDATE tasks SET phase=? WHERE id=?').run(phase, this.graphId);
  }

  private completionRequested(): boolean {
    const row = this.kernel.db.prepare('SELECT completion_requested AS requested FROM kernel_lifecycle WHERE task_id=?').get(this.graphId) as { requested: number } | undefined;
    return row?.requested === 1;
  }

  /** §5: an interface input from outside, refused once completion or stop has begun. */
  deliver(input: { nodeId: string; input: string; value: Json }): QueueRow {
    if (!this.kernel.latestRevision(this.graphId)?.definition.nodes[input.nodeId]) throw new RuntimeError('invalid_input', `Unknown agent ${input.nodeId}`);
    return this.deliverEndpoint(`${input.nodeId}.${input.input}`, input.value).queue!;
  }

  deliverEndpoint(endpoint: string, value: Json): ReturnType<KernelStore['deliverDirect']> {
    const phase = this.state()?.phase ?? 'running';
    if (this.completionRequested() || phase === 'completing' || phase === 'completed') {
      throw new RuntimeError('completing', `Graph ${this.graphId} is completing; external delivery is closed`);
    }
    if (phase === 'stopping' || phase === 'stopped') {
      throw new RuntimeError('stopping', `Graph ${this.graphId} is stopping; external delivery is closed`);
    }
    return this.kernel.deliverDirect(this.graphId, endpoint, value);
  }

  /** §5: chat that would trigger an execution is closed to the outside during completion. */
  chat(input: { nodeId: string; text: string }, internal = false): QueueRow {
    const phase = this.state()?.phase ?? 'running';
    if (phase === 'completed' || (!internal && (this.completionRequested() || phase === 'completing'))) {
      throw new RuntimeError('completing', `Graph ${this.graphId} is completing; execution-triggering chat is closed`);
    }
    if (phase === 'stopping' || phase === 'stopped') {
      throw new RuntimeError('stopping', `Graph ${this.graphId} is stopping; chat is closed`);
    }
    if (!this.kernel.latestRevision(this.graphId)?.definition.nodes[input.nodeId]) throw new RuntimeError('invalid_input', `Unknown agent ${input.nodeId}`);
    return new NodeQueue(this.kernel, this.graphId).enqueue({ nodeId: input.nodeId, kind: 'chat', text: input.text });
  }

  /** §8: request completion. External input closes; internal follow-on may still run. */
  complete(): GraphStateRow {
    this.ensureTask();
    const phase = this.state()!.phase;
    if (phase === 'completed') return this.state()!;
    if (phase === 'stopping' || phase === 'stopped') throw new RuntimeError('invalid_graph', 'Stopped graph cannot complete');
    this.kernel.db.prepare('INSERT INTO kernel_lifecycle(task_id,completion_requested) VALUES(?,1) ON CONFLICT(task_id) DO UPDATE SET completion_requested=1').run(this.graphId);
    this.setPhase('completing');
    return this.state()!;
  }

  /** §8: withdraw a completion request, restoring external input. */
  withdrawComplete(): GraphStateRow {
    this.ensureTask();
    if (['completed', 'stopping', 'stopped'].includes(this.state()!.phase) || !this.completionRequested()) {
      throw new RuntimeError('invalid_graph', `Graph ${this.graphId} is not completing`);
    }
    this.kernel.db.prepare('UPDATE kernel_lifecycle SET completion_requested=0 WHERE task_id=?').run(this.graphId);
    this.setPhase('running');
    return this.state()!;
  }

  /**
   * §8: settle a completion request. `completed` requires the queue, executions and
   * module transitions drained with no unresolved failure; a blocked node keeps the
   * graph `blocked`, which is not a drained state.
   */
  settleCompletion(): 'completed' | 'blocked' | 'completing' {
    this.ensureTask();
    if (this.state()!.phase === 'completed') return 'completed';
    if (['stopping', 'stopped'].includes(this.state()!.phase)) throw new RuntimeError('invalid_graph', 'Stopped graph cannot complete');
    if (!this.completionRequested()) throw new RuntimeError('invalid_graph', `Graph ${this.graphId} is not completing`);

    const queued = this.kernel.db.prepare("SELECT COUNT(*) AS n FROM kernel_queue WHERE task_id=? AND state IN ('queued','claimed')").get(this.graphId) as { n: number };
    const running = this.kernel.db.prepare("SELECT COUNT(*) AS n FROM kernel_executions WHERE task_id=? AND state='running'").get(this.graphId) as { n: number };
    const pausedOrFailed = this.kernel.db.prepare('SELECT COUNT(*) AS n FROM kernel_node_state WHERE task_id=? AND paused=1').get(this.graphId) as { n: number };
    const failedInputs = this.kernel.db.prepare("SELECT 1 FROM kernel_queue WHERE task_id=? AND state='failed' LIMIT 1").get(this.graphId);
    // Failed deliveries need an explicit retry/skip even if the node's later queue was resumed.
    const openQuestion = this.kernel.db.prepare("SELECT 1 FROM questions WHERE task_id=? AND status='open' LIMIT 1").get(this.graphId);
    if (pausedOrFailed.n > 0 || failedInputs || openQuestion) {
      this.setPhase('blocked');
      return 'blocked';
    }
    const pendingModules = this.kernel.db.prepare('SELECT COUNT(*) AS n FROM kernel_module_inbox WHERE task_id=? AND processed=0').get(this.graphId) as { n: number };
    const pendingOutputs = this.kernel.db.prepare('SELECT COUNT(*) AS n FROM kernel_transition_outbox o JOIN kernel_module_transitions t ON t.id=o.transition_id WHERE t.task_id=? AND o.routed=0').get(this.graphId) as { n: number };
    if (queued.n > 0 || running.n > 0 || pendingModules.n > 0 || pendingOutputs.n > 0) return 'completing';
    const acceptance = graphAcceptance(this.kernel, this.graphId, this.artifacts);
    const delivery = this.kernel.db.prepare('SELECT commit_sha FROM kernel_completion_delivery WHERE task_id=?').get(this.graphId) as { commit_sha: string } | undefined;
    if (!acceptance.ready || (this.kernel.store.task(this.graphId).integration_branch
      && (this.kernel.store.task(this.graphId).target_sha !== acceptance.commit || delivery?.commit_sha !== acceptance.commit))) {
      this.kernel.moduleTransaction(() => {
        if (acceptance.items.every(item => item.status === 'passed' || item.kind === 'human')) {
          for (const criterion of acceptance.human) insertQuestion(this.kernel.store, {
            taskId: this.graphId, nodeId: `@acceptance/${criterion.id}`, kind: 'human_check',
            data: { prompt: criterion.description, acceptanceId: criterion.id, commitSha: acceptance.commit },
          });
        }
        if (this.state()!.phase !== 'blocked') {
          const data = { graphId: this.graphId, commit: acceptance.commit, items: acceptance.items, deliveryPending: acceptance.ready };
          this.kernel.store.event(this.graphId, 'graph.acceptance.blocked', data as unknown as Json);
          wakeMaster(this.kernel.store, { taskId: this.graphId, kind: 'acceptance_blocked',
            dedupeKey: `${this.graphId}:acceptance:${createHash('sha256').update(canonicalJson(data)).digest('hex')}`, data: data as unknown as Json });
        }
        this.setPhase('blocked');
      });
      return 'blocked';
    }
    this.kernel.moduleTransaction(() => {
      this.setPhase('completed');
      wakeForTaskCompleted(this.kernel.store, this.graphId, { phase: 'completed', integrationSha: this.kernel.store.task(this.graphId).integration_sha });
      this.kernel.store.event(this.graphId, 'graph.completed', { revision: this.state()!.revision });
    });
    return 'completed';
  }

  /** §8: stop cancels the queue and blocks new dispatch. */
  stop(): GraphStateRow {
    this.ensureTask();
    if (['completed', 'stopped'].includes(this.state()!.phase)) return this.state()!;
    this.kernel.db.prepare("UPDATE tasks SET phase='stopping',paused=0 WHERE id=?").run(this.graphId);
    this.kernel.db.prepare('UPDATE kernel_module_inbox SET processed=1 WHERE task_id=?').run(this.graphId);
    this.kernel.db.prepare('UPDATE kernel_transition_outbox SET routed=1 WHERE transition_id IN (SELECT id FROM kernel_module_transitions WHERE task_id=?)').run(this.graphId);
    // Cancel every queued item; a claimed item keeps running until it settles.
    this.kernel.store.db.prepare("UPDATE kernel_queue SET state='done',reason='cancelled by stop' WHERE task_id=? AND state='queued'").run(this.graphId);
    this.kernel.store.event(this.graphId, 'graph.stopping', {});
    return this.state()!;
  }

  /** §8: stop settles once queued work is cancelled and in-flight executions stop. */
  settleStop(): 'stopped' | 'stopping' {
    this.ensureTask();
    if (this.state()!.phase === 'stopped') return 'stopped';
    if (this.state()!.phase !== 'stopping') throw new RuntimeError('invalid_graph', `Graph ${this.graphId} is not stopping`);
    this.kernel.db.prepare("UPDATE kernel_queue SET state='done',reason='cancelled by stop' WHERE task_id=? AND state='queued'").run(this.graphId);
    const queued = this.kernel.db.prepare("SELECT COUNT(*) AS n FROM kernel_queue WHERE task_id=? AND state IN ('queued','claimed')").get(this.graphId) as { n: number };
    const running = this.kernel.db.prepare("SELECT COUNT(*) AS n FROM kernel_executions WHERE task_id=? AND state='running'").get(this.graphId) as { n: number };
    if (queued.n > 0 || running.n > 0) return 'stopping';
    this.kernel.moduleTransaction(() => {
      this.setPhase('stopped');
      wakeMaster(this.kernel.store, { taskId: this.graphId, kind: 'task_stopped', dedupeKey: `${this.graphId}:stopped`, data: { graphId: this.graphId } });
      this.kernel.store.event(this.graphId, 'graph.stopped', { revision: this.state()!.revision });
    });
    return 'stopped';
  }

  /** §5: read the graph's structure and lifecycle for the main agent. */
  inspect(query: { kind: 'summary' | 'revision' | 'nodes' | 'deliveries'; executionId?: string }): Json {
    this.ensureTask();
    const latest = this.kernel.latestRevision(this.graphId)!;
    if (query.kind === 'summary') {
      return { graphId: this.graphId, phase: this.state()!.phase, revision: latest.version, name: latest.definition.name };
    }
    if (query.kind === 'revision') return latest.definition as unknown as Json;
    if (query.kind === 'nodes') {
      const rows = this.kernel.db.prepare('SELECT node_id, instance_id, kind, status FROM kernel_nodes WHERE task_id=?').all(this.graphId) as
        { node_id: string; instance_id: string; kind: string; status: string }[];
      return rows.map(row => ({ id: row.node_id, instanceId: row.instance_id, kind: row.kind, status: row.status })) as unknown as Json;
    }
    if (query.kind === 'deliveries') {
      if (!query.executionId) throw new RuntimeError('invalid_query', 'deliveries requires an executionId');
      return this.kernel.deliveriesFor(query.executionId) as unknown as Json;
    }
    throw new RuntimeError('invalid_query', `Unknown inspect query ${String((query as { kind?: unknown }).kind)}`);
  }
}
