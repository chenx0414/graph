import { wakeForBlockedNode } from './wake-ledger.ts';
import { occupiedSlots, executionLimit } from '../runtime/execution-slots.ts';
import { evaluateModule } from '../runtime/module-evaluator.ts';
import type { ModuleDefinition } from './interface-spec.ts';
import type { Json } from './types.ts';
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

export interface ModuleOperationRequest {
  moduleId: string; deliveryId: string; revisionVersion: number;
  operation: NonNullable<ModuleDefinition['operation']>; inputs: Record<string, Json>; state: Json; signal?: AbortSignal;
}

export interface GraphRunnerOptions {
  kernel: KernelStore;
  graphId: string;
  settleWorkspace?: (executionId: string) => Promise<void>;
  signal?: AbortSignal;
  operation?: (request: ModuleOperationRequest) => Promise<{ ok: boolean; state: Json; outputs: Record<string, Json>; diagnostics: string[] }>;
  /**
   * §9 metering, passed through to each node's executor. Absent means unmetered, which is
   * right for a program node and for a runtime configured without limits.
   */
  tokenBudget?: { budget: number; unlimited: boolean };
  reserveTokens?: number;
  /**
   * The resident host for one node. §7 gives each node its own long-lived Pi process, so
   * the runner asks for a host PER NODE rather than sharing one across the graph: a host
   * carries a node's identity and session lineage, and two nodes sharing one would share
   * the wrong session.
   */
  hostFor: (nodeId: string, revisionVersion: number) => RunnerHost | Promise<RunnerHost>;
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
    return (this.options.kernel.db.prepare("SELECT node_id FROM kernel_nodes WHERE task_id=? AND status!='retired' ORDER BY node_id").all(this.options.graphId) as { node_id: string }[])
      .map(row => row.node_id);
  }

  private pausedNodes(): string[] {
    return (this.options.kernel.db.prepare('SELECT node_id FROM kernel_node_state WHERE task_id=? AND paused=1').all(this.options.graphId) as { node_id: string }[])
      .map(row => row.node_id);
  }

  private queuedCount(): number {
    const row = this.options.kernel.db.prepare("SELECT COUNT(*) AS n FROM kernel_queue WHERE task_id=? AND state='queued'").get(this.options.graphId) as { n: number };
    const modules = this.options.kernel.db.prepare('SELECT COUNT(*) AS n FROM kernel_module_inbox WHERE task_id=? AND processed=0').get(this.options.graphId) as { n: number };
    return row.n + modules.n;
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

    const maxStuck = this.options.maxStuckPasses ?? 2;
    const beforeExecutions = (kernel.db.prepare('SELECT COUNT(*) AS n FROM kernel_executions WHERE task_id=?').get(this.options.graphId) as { n: number }).n;
    let stuck = 0;
    const active = new Map<string, Promise<void>>();
    let wake: (() => void) | undefined;
    const unsubscribe = kernel.store.onEvent(() => wake?.());
    try {
      for (;;) {
        const notification = new Promise<void>(resolve => { wake = resolve; });
        const task = kernel.store.task(this.options.graphId);
        if (this.options.signal?.aborted || task.paused || ['stopping', 'stopped', 'completed'].includes(task.phase)) {
          await Promise.all(active.values());
          break;
        }
        const modules = this.options.modules ?? new ModuleRuntime(kernel, this.options.graphId, kernel.latestRevision(this.options.graphId)!.version);
        const before = this.signature();
        for (const nodeId of this.nodeIds()) {
          if (active.has(nodeId) || kernel.nodeState(this.options.graphId, nodeId).paused || kernel.nodeStatus(this.options.graphId, nodeId) === 'blocked') continue;
          if (!kernel.nextQueued(this.options.graphId, nodeId)) continue;
          if (occupiedSlots(kernel.store, 'agent') >= executionLimit('agent')) break;
          const job = this.runNode(nodeId).catch(error => {
            kernel.setNodeQueuePaused(this.options.graphId, nodeId, true);
            kernel.blockNode(this.options.graphId, nodeId, error instanceof Error ? error.message : String(error));
          }).finally(() => { active.delete(nodeId); wake?.(); });
          active.set(nodeId, job);
        }
        await this.routeEmissions(modules);
        if (active.size) {
          await Promise.race([...active.values(), notification]);
          stuck = 0;
          continue;
        }
        if (this.signature() === before) {
          if (++stuck >= maxStuck) break;
        } else stuck = 0;
      }
    } finally { unsubscribe(); }
    const executions = (kernel.db.prepare('SELECT COUNT(*) AS n FROM kernel_executions WHERE task_id=?').get(this.options.graphId) as { n: number }).n - beforeExecutions;

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
    const completed = this.options.kernel.db.prepare("SELECT COUNT(*) AS n FROM kernel_executions WHERE task_id=? AND state!='running'").get(this.options.graphId) as { n: number };
    return `${queue.n}:${transitions.n}:${paused.n}:${completed.n}`;
  }

  /** One pending execution. Independent nodes run concurrently; each node stays serial. */
  private async runNode(nodeId: string): Promise<void> {
    const kernel = this.options.kernel;
    let driver: NodeTurnDriver;
    const executor = new NodeExecutor({
      maxItems: 1, kernel, graphId: this.options.graphId,
      ...(this.options.settleWorkspace ? { settleWorkspace: this.options.settleWorkspace } : {}),
      // Claim the input and persist its revision before any asynchronous session assembly.
      host: async (_executionId, revisionVersion) => {
        const nodeHost = await this.options.hostFor(nodeId, revisionVersion);
        driver = new NodeTurnDriver({
          kernel, graphId: this.options.graphId, nodeId, host: nodeHost,
          ...(this.options.initialContext ? { initialContext: () => this.options.initialContext!(nodeId) } : {}),
          submit: executionId => this.options.submit(executionId),
        });
        return nodeHost;
      },
      ...(this.options.signal ? { signal: this.options.signal } : {}),
      ...(this.options.tokenBudget && this.options.reserveTokens !== undefined
        ? { tokenBudget: this.options.tokenBudget, reserveTokens: this.options.reserveTokens } : {}),
      ...(this.options.workspace ? { workspace: () => this.options.workspace!(nodeId) } : {}),
      ...(this.options.artifacts ? { artifacts: this.options.artifacts } : {}),
    });
    await executor.runNode(nodeId, (executionId, attempt, injection, input) => driver.run(executionId, attempt, injection, input));
  }

  /**
   * Judge every module that has a pending input, and route what it emits. A module is
   * judged when a delivery has arrived since its last judgment, which is what makes an
   * `each` router re-judge on every update (§2).
   */
  private async routeModuleDeliveries(modules: ModuleRuntime): Promise<void> {
    const kernel = this.options.kernel;
    const graphId = this.options.graphId;
    // Recover judgments committed before a host crash but not yet broadcast.
    const pending = kernel.db.prepare(`SELECT t.id,t.module_id,t.outputs FROM kernel_transition_outbox o
      JOIN kernel_module_transitions t ON t.id=o.transition_id WHERE t.task_id=? AND o.routed=0 ORDER BY t.rowid`).all(graphId) as { id: string; module_id: string; outputs: string }[];
    for (const transition of pending) {
      routeModuleOutputs(kernel, modules, graphId, transition.module_id, {
        transitionId: transition.id, emitted: true, waiting: false, triggered: false,
        outputs: JSON.parse(transition.outputs), reasons: [],
      }, 0, true);
    }
    const rows = kernel.db.prepare(`SELECT d.id,d.to_endpoint,d.value,i.module_id FROM kernel_module_inbox i
      JOIN kernel_deliveries d ON d.id=i.delivery_id WHERE i.task_id=? AND i.processed=0 ORDER BY d.seq`).all(graphId) as { id: string; to_endpoint: string; value: string; module_id: string }[];
    for (const row of rows) {
      if (kernel.nodeState(graphId, row.module_id).paused) continue;
      const input = row.to_endpoint.slice(row.to_endpoint.indexOf('.') + 1);
      try {
        // Judgment and input consumption commit together; broadcasts recover via the outbox.
        const definition = kernel.revision(graphId, modules.revisionVersion)!.definition.modules[row.module_id]!;
        const evaluation = definition.type === 'operation'
          ? await modules.deliverOperation(row.module_id, input, JSON.parse(row.value), environment => {
            if (!this.options.operation) throw new Error('Host operation broker is unavailable');
            return this.options.operation({ moduleId: row.module_id, deliveryId: row.id, revisionVersion: modules.revisionVersion,
              operation: definition.operation!, inputs: environment.inputs, state: environment.state,
              ...(this.options.signal ? { signal: this.options.signal } : {}) });
          }, row.id)
          : definition.type === 'command'
            ? await modules.deliverCustom(row.module_id, input, JSON.parse(row.value), evaluateModule, row.id)
            : modules.consumeDelivery(row.module_id, input, JSON.parse(row.value), row.id);
        routeModuleOutputs(kernel, modules, graphId, row.module_id, evaluation, 0, true);
      } catch (error) {
        kernel.setNodeQueuePaused(graphId, row.module_id, true);
        const reason = error instanceof Error ? error.message : String(error);
        kernel.store.transaction(() => {
          kernel.store.event(graphId, 'graph.module.failed', { moduleId: row.module_id, deliveryId: row.id, reason });
          wakeForBlockedNode(kernel.store, graphId, { nodeId: row.module_id, reason, incidentId: row.id });
        });
      }
    }
  }

  /** Route anything the pass's judgments emitted, then let the loop settle. */
  private async routeEmissions(modules: ModuleRuntime): Promise<void> {
    await this.routeModuleDeliveries(modules);
  }
}
