import { occupiedSlots, executionLimit } from '../runtime/execution-slots.ts';
import { GraphRuntime } from './graph-runtime.ts';
import type { KernelStore } from './kernel-store.ts';
import type { ArtifactWorkspace } from './artifact-workspace.ts';
import { GraphRunner, type RunnerHost, type RunResult, type ModuleOperationRequest, type GraphRunnerOptions } from './graph-runner.ts';

/**
 * The production run hookup for the v2 kernel (Issue #1 §13.8).
 *
 * The switchover's first step lets a confirmed draft create a real v2 graph, but a graph
 * is inert until something drives it: a v2 task has no `nodes` rows, so the old scheduler
 * can never see it. This module is the bridge the host loop uses — it names the v2 graphs
 * that currently have queued work, and builds the runner that drains one.
 *
 * A v2 graph is "runnable" when the kernel holds something for it to do: a queued item, or
 * a module whose input arrived since its last judgment. Naming only those is what keeps the
 * host tick from spinning on graphs that have nothing to do.
 */

export interface GraphLaneOptions {
  kernel: KernelStore;
  close?: () => Promise<void>;
  operation?: (graphId: string, request: ModuleOperationRequest) => ReturnType<NonNullable<GraphRunnerOptions['operation']>>;
  closeGraph?: (graphId: string) => Promise<void>;
  /**
   * §9: the token budget a node runs under, and what one turn is expected to cost.
   *
   * Absent means unmetered. The executor reserves before a turn and charges what it
   * actually spent, parking a node it cannot afford rather than running it unbudgeted.
   */
  tokenBudget?: { budget: number; unlimited: boolean };
  reserveTokens?: number;
  /**
   * Build the resident host for one NODE. §7 gives each node its own long-lived process, so
   * the lane resolves a host per node, not per graph: a host carries a node's identity and
   * session lineage, and sharing one across nodes would share the wrong session. Assembling
   * a real session (its prompt, tools and credential) is asynchronous, so this is awaited.
   */
  host: (graphId: string, nodeId: string, config: unknown, revisionVersion: number) => Promise<RunnerHost> | RunnerHost;
  /** The serialized worker config, resolved per node. */
  config: (graphId: string, nodeId: string, revisionVersion: number) => Promise<unknown> | unknown;
  /** The first-turn briefing text for a node. */
  initialContext?: (graphId: string, nodeId: string) => string;
  /**
   * The node's workspace. Per NODE, not per graph: §7 gives each node its own process and
   * the old kernel gave each agent its own work copy, so two nodes must never be handed
   * the same tree to edit (HB-276).
   */
  workspace?: (graphId: string, nodeId: string) => string | undefined;
  /** The artifact store a declared deliverable is published to. */
  artifacts?: (graphId: string) => ArtifactWorkspace | undefined;
  /** How many passes may make no progress before a run reports itself stuck. */
  maxStuckPasses?: number;
}

/** One graph the lane is willing to run right now. */
export interface RunnableGraph {
  taskId: string;
  run: () => Promise<RunResult>;
}

export class GraphLane {
  private readonly options: GraphLaneOptions;
  private readonly shutdown = new AbortController();

  constructor(options: GraphLaneOptions) {
    this.options = options;
  }

  /** Release the resident processes and capability resources owned by this lane. */
  async close(): Promise<void> { this.shutdown.abort(); await this.options.close?.(); }

  /**
   * The v2 graphs that have work queued right now. A task is included only when it has a
   * published revision and its kernel holds a queued item, so a drained graph is not
   * proposed again on every host tick.
   */
  runnable(): RunnableGraph[] {
    if (this.shutdown.signal.aborted) return [];
    const kernel = this.options.kernel;
    const rows = kernel.db.prepare(`
      SELECT q.task_id FROM kernel_queue q LEFT JOIN kernel_node_state s ON s.task_id=q.task_id AND s.node_id=q.node_id
        WHERE q.state='queued' AND COALESCE(s.paused,0)=0 AND NOT EXISTS(SELECT 1 FROM kernel_nodes n WHERE n.task_id=q.task_id AND n.node_id=q.node_id AND n.status='blocked')
      UNION SELECT i.task_id FROM kernel_module_inbox i LEFT JOIN kernel_node_state s ON s.task_id=i.task_id AND s.node_id=i.module_id
        WHERE i.processed=0 AND COALESCE(s.paused,0)=0
      UNION SELECT t.task_id FROM kernel_transition_outbox o JOIN kernel_module_transitions t ON t.id=o.transition_id
        LEFT JOIN kernel_node_state s ON s.task_id=t.task_id AND s.node_id=t.module_id WHERE o.routed=0 AND COALESCE(s.paused,0)=0
      UNION SELECT id AS task_id FROM tasks WHERE phase IN ('completing','stopping')
      ORDER BY task_id`).all() as { task_id: string }[];
    const graphs: RunnableGraph[] = [];
    for (const row of rows) {
      const task = this.options.kernel.db.prepare('SELECT phase, paused FROM tasks WHERE id=?').get(row.task_id) as { phase: string; paused: number } | undefined;
      // A terminal or paused task is not runnable: the loop leaves it for the operator.
      if (!task || task.paused || !['running', 'idle', 'blocked', 'completing', 'stopping'].includes(task.phase)) continue;
      if (!kernel.latestRevision(row.task_id)) continue;
      if (occupiedSlots(kernel.store, 'agent') >= executionLimit('agent')) {
        const queued = kernel.db.prepare("SELECT 1 FROM kernel_queue WHERE task_id=? AND state='queued' LIMIT 1").get(row.task_id);
        const moduleWork = kernel.db.prepare('SELECT 1 FROM kernel_module_inbox WHERE task_id=? AND processed=0 LIMIT 1').get(row.task_id)
          ?? kernel.db.prepare('SELECT 1 FROM kernel_transition_outbox o JOIN kernel_module_transitions t ON t.id=o.transition_id WHERE t.task_id=? AND o.routed=0 LIMIT 1').get(row.task_id);
        if (queued && !moduleWork && task.phase !== 'stopping') continue;
      }
      graphs.push({ taskId: row.task_id, run: () => this.runGraph(row.task_id) });
    }
    return graphs;
  }

  /** Drain one graph to completion (or until it is stuck) through the real executor. */
  private async runGraph(graphId: string): Promise<RunResult> {
    const kernel = this.options.kernel;
    const revision = kernel.latestRevision(graphId);
    if (!revision) return { drained: true, executions: 0, blockedNodes: [] };
    const runner = new GraphRunner({
      kernel,
      graphId, signal: this.shutdown.signal,
      ...(this.options.operation ? { operation: (request: ModuleOperationRequest) => this.options.operation!(graphId, request) } : {}),
      ...(this.options.tokenBudget && this.options.reserveTokens !== undefined
        ? { tokenBudget: this.options.tokenBudget, reserveTokens: this.options.reserveTokens } : {}),
      hostFor: async (nodeId: string, revisionVersion: number) => {
        const config = await this.options.config(graphId, nodeId, revisionVersion);
        if (this.shutdown.signal.aborted) throw new Error('Graph runtime is closing');
        return this.options.host(graphId, nodeId, config, revisionVersion);
      },
      // A node submits through its own `submit` tool, which the host executes over the real
      // execution (HB-262) - so by the time this runs, the kernel already holds whatever the
      // node submitted, and the refusal text already went back to the model. This never
      // fabricates a submission: the driver decides from the kernel alone whether the
      // execution is done.
      submit: () => undefined,
      ...(this.options.workspace ? { workspace: (nodeId: string) => this.options.workspace!(graphId, nodeId) } : {}),
      ...(this.options.artifacts ? { artifacts: () => this.options.artifacts!(graphId) } : {}),
      ...(this.options.initialContext ? { initialContext: (nodeId: string) => this.options.initialContext!(graphId, nodeId) } : {}),
      ...(this.options.maxStuckPasses !== undefined ? { maxStuckPasses: this.options.maxStuckPasses } : {}),
    });
    const result = await runner.drain();
    const runtime = new GraphRuntime(kernel, graphId);
    const intent = (kernel.db.prepare('SELECT completion_requested AS requested FROM kernel_lifecycle WHERE task_id=?').get(graphId) as { requested: number } | undefined)?.requested;
    if (runtime.state()?.phase === 'stopping') runtime.settleStop();
    else if (intent) runtime.settleCompletion();
    if (['completed', 'stopped'].includes(runtime.state()!.phase)) await this.options.closeGraph?.(graphId);
    return result;
  }
}
