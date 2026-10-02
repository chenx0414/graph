import type { KernelStore } from './kernel-store.ts';
import { GraphRunner, type RunnerHost, type RunResult } from './graph-runner.ts';

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
  /**
   * Build the resident host for one NODE. §7 gives each node its own long-lived process, so
   * the lane resolves a host per node, not per graph: a host carries a node's identity and
   * session lineage, and sharing one across nodes would share the wrong session. Assembling
   * a real session (its prompt, tools and credential) is asynchronous, so this is awaited.
   */
  host: (graphId: string, nodeId: string, config: unknown) => Promise<RunnerHost> | RunnerHost;
  /** The serialized worker config, resolved per node. */
  config: (graphId: string, nodeId: string) => Promise<unknown> | unknown;
  /** The first-turn briefing text for a node. */
  initialContext?: (graphId: string, nodeId: string) => string;
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

  constructor(options: GraphLaneOptions) {
    this.options = options;
  }

  /**
   * The v2 graphs that have work queued right now. A task is included only when it has a
   * published revision and its kernel holds a queued item, so a drained graph is not
   * proposed again on every host tick.
   */
  runnable(): RunnableGraph[] {
    const kernel = this.options.kernel;
    const rows = kernel.db.prepare(`SELECT DISTINCT task_id FROM kernel_queue WHERE state='queued' ORDER BY task_id`).all() as { task_id: string }[];
    const graphs: RunnableGraph[] = [];
    for (const row of rows) {
      const task = this.options.kernel.db.prepare('SELECT phase, paused FROM tasks WHERE id=?').get(row.task_id) as { phase: string; paused: number } | undefined;
      // A terminal or paused task is not runnable: the loop leaves it for the operator.
      if (!task || task.paused || (task.phase !== 'running' && task.phase !== 'completing')) continue;
      if (!kernel.latestRevision(row.task_id)) continue;
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
      graphId,
      hostFor: async (nodeId: string) => this.options.host(graphId, nodeId, await this.options.config(graphId, nodeId)),
      // A node submits through its own `submit` tool, which the host executes over the real
      // execution (HB-262) - so by the time this runs, the kernel already holds whatever the
      // node submitted, and the refusal text already went back to the model. This never
      // fabricates a submission: the driver decides from the kernel alone whether the
      // execution is done.
      submit: () => undefined,
      ...(this.options.initialContext ? { initialContext: (nodeId: string) => this.options.initialContext!(graphId, nodeId) } : {}),
      ...(this.options.maxStuckPasses !== undefined ? { maxStuckPasses: this.options.maxStuckPasses } : {}),
    });
    return runner.drain();
  }
}
