import type { KernelStore } from './kernel-store.ts';
import type { ArtifactWorkspace } from './artifact-workspace.ts';
import { NodeExecutor, type ExecutorHost } from './node-executor.ts';
import { NodeTurnDriver } from './node-turn-driver.ts';
import { ModuleRuntime } from './module-runtime.ts';
import { routeModuleOutputs } from './module-router.ts';

/**
 * The runner that drives a v2 graph to completion (Issue #1 §13.8).
 *
 * Every piece of the interface-delivery model exists — the queue, the executor, the turn
 * driver, the submit bridge, the module runtime and the router — but a graph is inert
 * until something drives them together. This is that driver, and without it §13.8's
 * switchover would switch to a kernel that never actually ran a graph.
 *
 * One pass is:
 *
 *   1. drain every node that has queued work, through the real executor and turn driver;
 *   2. judge every module whose inputs changed, and route what it emitted, so a module's
 *      output queues the next node or feeds a downstream module;
 *   3. repeat while a pass made progress.
 *
 * It stops when the graph is drained, or when no pass can make progress — a node whose
 * budget is spent pauses its own queue and is reported, rather than being retried
 * forever. A `completing` graph still drains its internal follow-on; the external gate
 * belongs to the graph runtime and is not bypassed here.
 */

/** The subset of `ResidentHost` a run needs. */
export interface RunnerHost extends ExecutorHost {
  turn(text: string): Promise<{ turnId: string; inspect: unknown }>;
}

export interface GraphRunnerOptions {
  kernel: KernelStore;
  graphId: string;
  /**
   * The resident host for one node. §7 gives each node its own long-lived Pi process, so
   * the runner asks for a host PER NODE rather than sharing one across the graph: a host
   * carries a node's identity and session lineage, and two nodes sharing one would share
   * the wrong session.
   */
  hostFor: (nodeId: string) => RunnerHost | Promise<RunnerHost>;
  /** The node's own workspace (its work copy), where a declared deliverable must exist. */
  workspace?: (nodeId: string) => string | undefined;
  /** The artifact store a declared deliverable is published to. */
  artifacts?: () => ArtifactWorkspace | undefined;
  /** Runs the node's submit for one execution; returns any missing-required gap. */
  submit: (executionId: string) => { missing: string[] } | void;
  /** The first-turn briefing for a node. */
  initialContext?: (nodeId: string) => string;
  /** A module runtime for the revision being run; created from the kernel when absent. */
  modules?: ModuleRuntime;
  /** How many passes may make no progress before the run reports itself stuck. */
  maxStuckPasses?: number;
}

export interface RunResult {
  /** True when nothing was left queued and no node was left paused. */
  drained: boolean;
  /** How many executions the run opened. */
  executions: number;
  /** Nodes left paused (failed) — the work the main agent must handle. */
  blockedNodes: string[];
}

export class GraphRunner {
  private readonly options: GraphRunnerOptions;

  constructor(options: GraphRunnerOptions) {
    this.options = options;
  }

  private nodeIds(): string[] {
    return (this.options.kernel.db.prepare('SELECT node_id FROM kernel_nodes WHERE task_id=? ORDER BY node_id').all(this.options.graphId) as { node_id: string }[])
      .map(row => row.node_id);
  }

  private moduleIds(): string[] {
    return (this.options.kernel.db.prepare('SELECT module_id FROM kernel_modules WHERE task_id=? ORDER BY module_id').all(this.options.graphId) as { module_id: string }[])
      .map(row => row.module_id);
  }

  private pausedNodes(): string[] {
    return (this.options.kernel.db.prepare('SELECT node_id FROM kernel_node_state WHERE task_id=? AND paused=1').all(this.options.graphId) as { node_id: string }[])
      .map(row => row.node_id);
  }

  private queuedCount(): number {
    const row = this.options.kernel.db.prepare("SELECT COUNT(*) AS n FROM kernel_queue WHERE task_id=? AND state='queued'").get(this.options.graphId) as { n: number };
    return row.n;
  }

  /**
   * Drain the graph. External triggering (an initial delivery, a chat line) is the
   * caller's business: this runs whatever the queues already hold, plus everything those
   * deliveries produce.
   */
  async drain(): Promise<RunResult> {
    const kernel = this.options.kernel;
    const revision = kernel.latestRevision(this.options.graphId);
    if (!revision) return { drained: true, executions: 0, blockedNodes: [] };
    const modules = this.options.modules ?? new ModuleRuntime(kernel, this.options.graphId, revision.version);
    const maxStuck = this.options.maxStuckPasses ?? 2;
    let executions = 0;
    let stuck = 0;

    for (;;) {
      const before = this.signature();
      executions += await this.drainNodes(modules);
      this.routeEmissions(modules);
      await this.drainNodes(modules);

      if (this.signature() === before) {
        stuck += 1;
        if (stuck >= maxStuck) break;
      } else {
        stuck = 0;
      }
    }

    const blockedNodes = this.pausedNodes();
    return {
      drained: this.queuedCount() === 0 && blockedNodes.length === 0,
      executions,
      blockedNodes,
    };
  }

  /** A cheap fingerprint of everything a pass could change, to detect no progress. */
  private signature(): string {
    const queue = this.options.kernel.db.prepare("SELECT COUNT(*) AS n FROM kernel_queue WHERE task_id=? AND state IN ('queued','claimed')").get(this.options.graphId) as { n: number };
    const transitions = this.options.kernel.db.prepare('SELECT COUNT(*) AS n FROM kernel_module_transitions WHERE task_id=?').get(this.options.graphId) as { n: number };
    const paused = this.options.kernel.db.prepare('SELECT COUNT(*) AS n FROM kernel_node_state WHERE task_id=? AND paused=1').get(this.options.graphId) as { n: number };
    return `${queue.n}:${transitions.n}:${paused.n}`;
  }

  /** Drain every node that has queued work. Returns how many executions were opened. */
  private async drainNodes(modules: ModuleRuntime): Promise<number> {
    const kernel = this.options.kernel;
    let executions = 0;
    for (const nodeId of this.nodeIds()) {
      if (kernel.nodeState(this.options.graphId, nodeId).paused) continue;
      if (!kernel.nextQueued(this.options.graphId, nodeId)) continue;

      const nodeHost = await this.options.hostFor(nodeId);
      const driver = new NodeTurnDriver({
        kernel, graphId: this.options.graphId, nodeId, host: nodeHost,
        initialContext: () => this.options.initialContext ? this.options.initialContext(nodeId) : '',
        submit: (executionId) => {
          const execution = kernel.execution(executionId);
          const gap = execution ? this.options.submit(executionId) : undefined;
          executions += 1;
          // A submit that landed on a module hands the judgment to the router, which
          // queues whatever the module emits.
          if (execution) this.routeModuleDeliveries(modules);
          return gap;
        },
      });
      const executor = new NodeExecutor({
        kernel, graphId: this.options.graphId, host: nodeHost,
        ...(this.options.workspace ? { workspace: () => this.options.workspace!(nodeId) } : {}),
        ...(this.options.artifacts ? { artifacts: this.options.artifacts } : {}),
      });
      await executor.runNode(nodeId, (executionId, attempt, injection) => driver.run(executionId, attempt, injection));
    }
    return executions;
  }

  /**
   * Judge every module that has a pending input, and route what it emits. A module is
   * judged when a delivery has arrived since its last judgment, which is what makes an
   * `each` router re-judge on every update (§2).
   */
  private routeModuleDeliveries(modules: ModuleRuntime): void {
    for (const moduleId of this.moduleIds()) {
      const deliveredAt = (this.options.kernel.db.prepare('SELECT MAX(updated_at) AS t FROM kernel_module_inputs WHERE task_id=? AND module_id=?').get(this.options.graphId, moduleId) as { t: number | null }).t;
      const judgedAt = (this.options.kernel.db.prepare('SELECT MAX(created_at) AS t FROM kernel_module_transitions WHERE task_id=? AND module_id=?').get(this.options.graphId, moduleId) as { t: number | null }).t;
      if (deliveredAt === null) continue;
      if (judgedAt !== null && deliveredAt <= judgedAt) continue;
      const evaluation = modules.evaluate(moduleId);
      routeModuleOutputs(this.options.kernel, modules, this.options.graphId, moduleId, evaluation);
    }
  }

  /** Route anything the pass's judgments emitted, then let the loop settle. */
  private routeEmissions(modules: ModuleRuntime): void {
    this.routeModuleDeliveries(modules);
  }
}
