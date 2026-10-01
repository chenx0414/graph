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
  definition: GraphDefinition;
  /** Node ids to retire explicitly; every omitted node must be named here (§8). */
  retire?: string[];
}

export interface CreatedGraph {
  graphId: string;
  definition: GraphDefinition;
  revision: { version: number };
}

export class GraphRuntime {
  constructor(private readonly kernel: KernelStore, private readonly graphId: string) {}

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
    const latest = this.kernel.latestRevision(this.graphId);
    if (!latest) throw new RuntimeError('invalid_graph', `Graph ${this.graphId} has no revision to patch`);
    if (latest.version !== input.baseRevision) {
      // Zero partial change: the caller is told the current version and must retry.
      throw new RuntimeError('stale_revision', `Patch is based on revision ${input.baseRevision} but the current revision is ${latest.version}`);
    }
    // The definition is validated whole before a revision is written.
    const parsed = parseGraphDefinition(input.changes.definition);
    if (input.changes.retire?.length) {
      for (const id of input.changes.retire) {
        if (!latest.definition.nodes[id] && !latest.definition.modules[id]) {
          throw new RuntimeError('invalid_graph', `Retire names unknown node or module ${id}`);
        }
      }
    }
    const revision = this.kernel.publishRevision(this.graphId, { definition: parsed, reason: input.changes.reason });
    return { revision: revision.version };
  }

  state(): GraphStateRow | null {
    const row = this.kernel.db.prepare('SELECT phase FROM tasks WHERE id=?').get(this.graphId) as { phase: string } | undefined;
    if (!row) return null;
    const latest = this.kernel.latestRevision(this.graphId);
    return { graphId: this.graphId, phase: row.phase as GraphPhase, revision: latest?.version ?? 0 };
  }

  private setPhase(phase: GraphPhase): void {
    this.kernel.store.db.prepare('UPDATE tasks SET phase=? WHERE id=?').run(phase, this.graphId);
  }

  /** §5: an interface input from outside, refused once completion or stop has begun. */
  deliver(input: { nodeId: string; input: string; value: Json }): QueueRow {
    const phase = this.state()?.phase ?? 'running';
    if (phase === 'completing' || phase === 'completed') {
      throw new RuntimeError('completing', `Graph ${this.graphId} is completing; external delivery is closed`);
    }
    if (phase === 'stopping' || phase === 'stopped') {
      throw new RuntimeError('stopping', `Graph ${this.graphId} is stopping; external delivery is closed`);
    }
    return new NodeQueue(this.kernel, this.graphId).enqueue({ nodeId: input.nodeId, kind: 'delivery', input: input.input, value: input.value });
  }

  /** §5: chat that would trigger an execution is closed to the outside during completion. */
  chat(input: { nodeId: string; text: string }): QueueRow {
    const phase = this.state()?.phase ?? 'running';
    if (phase === 'completing' || phase === 'completed') {
      throw new RuntimeError('completing', `Graph ${this.graphId} is completing; execution-triggering chat is closed`);
    }
    if (phase === 'stopping' || phase === 'stopped') {
      throw new RuntimeError('stopping', `Graph ${this.graphId} is stopping; chat is closed`);
    }
    return new NodeQueue(this.kernel, this.graphId).enqueue({ nodeId: input.nodeId, kind: 'chat', text: input.text });
  }

  /** §8: request completion. External input closes; internal follow-on may still run. */
  complete(): GraphStateRow {
    this.ensureTask();
    const phase = this.state()!.phase;
    if (phase === 'completed') return this.state()!;
    this.setPhase('completing');
    return this.state()!;
  }

  /** §8: withdraw a completion request, restoring external input. */
  withdrawComplete(): GraphStateRow {
    this.ensureTask();
    if (this.state()!.phase !== 'completing') {
      throw new RuntimeError('invalid_graph', `Graph ${this.graphId} is not completing`);
    }
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
    if (this.state()!.phase !== 'completing') throw new RuntimeError('invalid_graph', `Graph ${this.graphId} is not completing`);

    const queued = this.kernel.db.prepare("SELECT COUNT(*) AS n FROM kernel_queue WHERE task_id=? AND state IN ('queued','claimed')").get(this.graphId) as { n: number };
    const running = this.kernel.db.prepare("SELECT COUNT(*) AS n FROM kernel_executions WHERE task_id=? AND state='running'").get(this.graphId) as { n: number };
    const pausedOrFailed = this.kernel.db.prepare('SELECT COUNT(*) AS n FROM kernel_node_state WHERE task_id=? AND paused=1').get(this.graphId) as { n: number };
    // A paused node is a failed node awaiting the main agent — blocked, not drained.
    if (pausedOrFailed.n > 0) {
      this.setPhase('blocked');
      return 'blocked';
    }
    if (queued.n > 0 || running.n > 0) return 'completing';
    this.setPhase('completed');
    return 'completed';
  }

  /** §8: stop cancels the queue and blocks new dispatch. */
  stop(): GraphStateRow {
    this.ensureTask();
    if (this.state()!.phase === 'stopped') return this.state()!;
    this.setPhase('stopping');
    // Cancel every queued item; a claimed item keeps running until it settles.
    this.kernel.store.db.prepare("UPDATE kernel_queue SET state='failed' WHERE task_id=? AND state='queued'").run(this.graphId);
    return this.state()!;
  }

  /** §8: stop settles once queued work is cancelled and in-flight executions stop. */
  settleStop(): 'stopped' | 'stopping' {
    this.ensureTask();
    if (this.state()!.phase !== 'stopping') throw new RuntimeError('invalid_graph', `Graph ${this.graphId} is not stopping`);
    const queued = this.kernel.db.prepare("SELECT COUNT(*) AS n FROM kernel_queue WHERE task_id=? AND state IN ('queued','claimed')").get(this.graphId) as { n: number };
    if (queued.n > 0) return 'stopping';
    this.setPhase('stopped');
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
