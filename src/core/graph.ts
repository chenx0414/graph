import { randomUUID } from 'node:crypto';
import { RuntimeError, type ContainerSpec, type DependencySource, type Json, type LoopSpec, type NodeSpec, type OperationResult, type Proposal } from './types.ts';
import type { TaskStore } from './store.ts';
import { unknownUsageIsNonBlocking } from './budget-ledger.ts';
import { canonicalJson } from './store.ts';
import { closeUserWait } from './time-ledger.ts';

const invalid = (reason: string): never => { throw new RuntimeError('invalid_proposal', reason); };

/** Containers are structural: their leaves share the same operation scheduler and instance pool. */
export class GraphPlan {
  readonly nodes: Map<string, NodeSpec>;
  readonly containers: Map<string, ContainerSpec>;
  readonly dependencies = new Map<string, string[]>();
  readonly conditions = new Map<string, { node: string; case: string }[]>();
  readonly descendants = new Map<string, string[]>();
  readonly loops: LoopSpec[];
  constructor(proposal: Pick<Proposal, 'nodes' | 'containers' | 'loops'>) {
    this.nodes = new Map(proposal.nodes.map(node => [node.id, node]));
    this.containers = new Map((proposal.containers ?? []).map(container => [container.id, container]));
    if (this.containers.size !== (proposal.containers ?? []).length) invalid('Container IDs must be unique');
    for (const container of this.containers.values()) {
      if (!container.id.trim() || this.nodes.has(container.id)) invalid('Containers require distinct IDs');
      const visited = new Set<string>([container.id]);
      let parent = container.parent;
      while (parent) {
        if (!this.containers.has(parent) || visited.has(parent)) invalid('Invalid container hierarchy');
        visited.add(parent); parent = this.containers.get(parent)!.parent;
      }
      this.descendants.set(container.id, []);
    }
    for (const node of this.nodes.values()) {
      const dependencies = [...(node.dependsOn ?? [])];
      const conditions = node.when ? [node.when] : [];
      let parent = node.container;
      while (parent) {
        const container = this.containers.get(parent);
        if (!container) invalid('Node refers to an unknown container');
        this.descendants.get(parent)!.push(node.id);
        dependencies.push(...(container!.dependsOn ?? []));
        if (container!.when) conditions.push(container!.when);
        parent = container!.parent;
      }
      for (const condition of conditions) {
        if (!this.nodes.get(condition.node)?.routes?.includes(condition.case)) invalid('Branch must select a declared router case');
        dependencies.push(condition.node);
      }
      this.conditions.set(node.id, conditions);
      this.dependencies.set(node.id, [...new Set(dependencies)]);
    }
    for (const container of this.containers.values()) {
      if (!this.descendants.get(container.id)!.length || !Array.isArray(container.outputs) || !container.outputs.length) invalid('Containers require nodes and exported outputs');
      if (new Set(container.outputs).size !== container.outputs.length) invalid('Container outputs must be unique');
      for (const output of container.outputs) {
        const leaves = this.leaves(output);
        if (output === container.id || !leaves.length || leaves.some(id => !this.descendants.get(container.id)!.includes(id))) invalid('Container can export only its descendants');
      }
    }
    const visiting = new Set<string>(); const visited = new Set<string>();
    const visit = (id: string) => {
      if (visiting.has(id)) invalid('Forward dependencies cannot contain cycles');
      if (visited.has(id)) return;
      visiting.add(id);
      for (const dependency of this.dependencies.get(id)!) for (const leaf of this.leaves(dependency)) visit(leaf);
      visiting.delete(id); visited.add(id);
    };
    for (const id of this.nodes.keys()) visit(id);
    this.loops = proposal.loops ?? [];
    const seen = new Set<string>();
    for (const loop of this.loops) {
      if (!this.nodes.has(loop.from) || !this.nodes.has(loop.to) || loop.from === loop.to) invalid('Loop endpoints must be distinct existing nodes');
      const key = `${loop.from}->${loop.to}`;
      if (seen.has(key)) invalid('Loops must be unique');
      seen.add(key);
      if (!this.ancestors(loop.from).has(loop.to)) invalid('Loop must return to an upstream node');
    }
  }
  ancestors(id: string): Set<string> {
    const seen = new Set<string>();
    const walk = (nodeId: string) => {
      for (const dependency of this.dependencies.get(nodeId) ?? []) {
        for (const leaf of this.leaves(dependency)) {
          if (seen.has(leaf)) continue;
          seen.add(leaf);
          walk(leaf);
        }
      }
    };
    walk(id);
    return seen;
  }
  dependents(id: string): string[] {
    return [...this.nodes.keys()].filter(nodeId => nodeId !== id && this.ancestors(nodeId).has(id));
  }
  leaves(id: string): string[] {
    if (this.nodes.has(id)) return [id];
    const leaves = this.descendants.get(id);
    if (!leaves) invalid('Dependencies must refer to existing nodes or containers');
    return leaves!;
  }
}

export type GraphNodeState = { id: string; status: string; output: string | null; route: string | null; activation_id: string; output_version: number; output_operation: string | null };
export class GraphState {
  readonly plan: GraphPlan;
  private readonly states: Map<string, GraphNodeState>;
  private readonly provenance: Map<string, DependencySource>;
  constructor(plan: GraphPlan, states: GraphNodeState[], sources: DependencySource[] = []) { this.plan = plan; this.states = new Map(states.map(state => [state.id, state])); this.provenance = new Map(sources.map(source => [source.nodeId, source])); }
  status(id: string): string {
    if (this.plan.nodes.has(id)) {
      const status = this.states.get(id)?.status ?? 'pending';
      return status === 'failed' && this.plan.nodes.get(id)!.optional ? 'skipped' : status;
    }
    const statuses = this.plan.leaves(id).map(leaf => this.status(leaf));
    if (statuses.every(status => status === 'skipped')) return 'skipped';
    if (statuses.every(status => ['succeeded', 'skipped'].includes(status))) return 'succeeded';
    if (statuses.includes('blocked')) return 'blocked';
    return 'pending';
  }
  output(id: string): Json {
    if (this.plan.nodes.has(id)) { const output = this.states.get(id)?.output; return this.status(id) !== 'skipped' && output ? JSON.parse(output) as Json : null; }
    return Object.fromEntries(this.plan.containers.get(id)!.outputs.map(output => [output, this.output(output)]));
  }
  readiness(id: string): 'ready' | 'waiting' | 'skip' {
    for (const condition of this.plan.conditions.get(id)!) {
      if (this.status(condition.node) === 'skipped') return 'skip';
      if (this.status(condition.node) !== 'succeeded') return 'waiting';
      if (this.states.get(condition.node)!.route !== condition.case) return 'skip';
    }
    const statuses = this.plan.dependencies.get(id)!.map(dependency => this.status(dependency));
    if (statuses.some(status => !['succeeded', 'skipped'].includes(status))) return 'waiting';
    return statuses.length && statuses.every(status => status === 'skipped') ? 'skip' : 'ready';
  }
  inputs(id: string): Record<string, Json> { return Object.fromEntries(this.plan.dependencies.get(id)!.map(dependency => [dependency, this.output(dependency)])); }
  sources(id: string): Record<string, DependencySource[]> {
    return Object.fromEntries(this.plan.dependencies.get(id)!.map(dependency => [dependency, this.plan.leaves(dependency)
      .filter(leaf => this.status(leaf) === 'succeeded' && this.provenance.has(leaf)).map(leaf => this.provenance.get(leaf)!)]));
  }
  containers() { return [...this.plan.containers.values()].map(container => ({ ...container, nodes: this.plan.leaves(container.id), status: this.status(container.id), output: this.output(container.id) })); }
}

export function loadGraph(store: TaskStore, taskId: string) {
  const task = store.task(taskId);
  const proposal = JSON.parse((store.db.prepare('SELECT spec FROM graph_revisions WHERE task_id=? AND version=?').get(taskId, task.graph_version) as { spec: string }).spec) as Proposal;
  const states = store.db.prepare('SELECT id,status,output,route,activation_id,output_version,output_operation FROM nodes WHERE task_id=?').all(taskId) as GraphNodeState[];
  const sources = states.filter(state => state.output_operation).map(state => {
    const operation = store.db.prepare('SELECT activation_id,instance_id,result FROM operations WHERE id=?')
      .get(state.output_operation!) as { activation_id: string; instance_id: string | null; result: string };
    const result = JSON.parse(operation.result) as OperationResult;
    return { nodeId: state.id, instanceId: operation.instance_id, operationId: state.output_operation!, activationId: operation.activation_id, outputVersion: state.output_version,
      artifacts: (result.artifacts ?? []).map(artifact => ({ ...artifact, nodeId: state.id, operationId: state.output_operation!, activationId: operation.activation_id })) };
  });
  return new GraphState(new GraphPlan(proposal), states, sources);
}

export function createActivation(store: TaskStore, taskId: string, nodeId: string, graphVersion: number, round = 1) {
  const id = randomUUID();
  store.db.prepare("INSERT INTO activations(id,task_id,node_id,graph_version,round,state,input_versions) VALUES(?,?,?,?,?,'pending','{}')").run(id, taskId, nodeId, graphVersion, round);
  store.db.prepare('UPDATE nodes SET activation_id=? WHERE task_id=? AND id=?').run(id, taskId, nodeId);
  return id;
}

export function hasLockedQuestion(store: TaskStore, taskId: string, nodeId: string) {
  const node = store.db.prepare('SELECT instance_id FROM nodes WHERE task_id=? AND id=?')
    .get(taskId, nodeId) as { instance_id: string | null } | undefined;
  const kinds = unknownUsageIsNonBlocking(store, node?.instance_id)
    ? "kind IN ('budget','reservation_exceeded','permission')"
    : "kind IN ('budget','unknown_usage','reservation_exceeded','permission')";
  return Boolean(store.db.prepare(`SELECT id FROM questions WHERE task_id=? AND node_id=? AND status='open' AND ${kinds}`).get(taskId, nodeId));
}

/** Invalidate an idle node for recheck. Locked budget/usage/permission questions stay blocking. */
/** A retired activation's open questions describe a version that no longer exists. Leaving them open
 * keeps a stale acceptance (or stale problem) in the user's inbox, so a reset supersedes them and
 * records why. The node re-asks when it is dispatched again. */
export function supersedeOpenQuestions(store: TaskStore, taskId: string, nodeId: string) {
  const open = store.db.prepare("SELECT id FROM questions WHERE task_id=? AND node_id=? AND status='open'")
    .all(taskId, nodeId) as { id: string }[];
  for (const question of open) {
    store.db.prepare("UPDATE questions SET status='resolved',answer=? WHERE id=?")
      .run(canonicalJson({ type: 'superseded', reason: 'the activation that asked was retired' }), question.id);
    closeUserWait(store, taskId, nodeId);
  }
  if (open.length) store.event(taskId, 'question.superseded', { nodeId, count: open.length });
  return open.length;
}

export function resetIdleNode(store: TaskStore, taskId: string, nodeId: string, graphVersion: number, round = 1, skipStatuses: string[] = []) {
  const node = store.db.prepare('SELECT instance_id,activation_id,status FROM nodes WHERE task_id=? AND id=?').get(taskId, nodeId) as { instance_id: string | null; activation_id: string; status: string };
  if (['preparing', 'running', ...skipStatuses].includes(node.status) || hasLockedQuestion(store, taskId, nodeId)) {
    return { reset: false, instanceId: node.instance_id };
  }
  supersedeOpenQuestions(store, taskId, nodeId);
  store.db.prepare("UPDATE activations SET state='invalidated' WHERE id=?").run(node.activation_id);
  store.db.prepare('UPDATE evidence SET valid=0 WHERE task_id=? AND node_id=? AND valid=1').run(taskId, nodeId);
  createActivation(store, taskId, nodeId, graphVersion, round);
  store.db.prepare("UPDATE nodes SET status='pending',output=NULL,route=NULL,output_operation=NULL WHERE task_id=? AND id=?").run(taskId, nodeId);
  return { reset: true, instanceId: node.instance_id };
}

/** Rework returns to the original node with a new activation; successful siblings are left untouched. */
export function reactivate(store: TaskStore, taskId: string, targetIds: string | string[]) {
  const task = store.task(taskId);
  const graph = loadGraph(store, taskId);
  const targets = [...new Set(Array.isArray(targetIds) ? targetIds : [targetIds])];
  const rounds = new Map<string, number>();
  const affected = new Set<string>();
  for (const targetId of targets) {
    const target = store.db.prepare('SELECT status,activation_id FROM nodes WHERE task_id=? AND id=?').get(taskId, targetId) as { status: string; activation_id: string };
    if (['preparing', 'running'].includes(target.status)) throw new RuntimeError('invalid_activation', 'A node cannot run two activations at once');
    const current = store.db.prepare('SELECT round FROM activations WHERE id=?').get(target.activation_id) as { round: number };
    rounds.set(targetId, current.round + 1);
    affected.add(targetId);
    for (const dependent of graph.plan.dependents(targetId)) affected.add(dependent);
  }
  for (const id of affected) {
    const node = store.db.prepare('SELECT activation_id FROM nodes WHERE task_id=? AND id=?').get(taskId, id) as { activation_id: string };
    store.db.prepare('UPDATE evidence SET valid=0 WHERE task_id=? AND node_id=? AND valid=1').run(taskId, id);
    if (hasLockedQuestion(store, taskId, id)) continue;
    store.db.prepare('UPDATE activations SET state=? WHERE id=?').run(targets.includes(id) ? 'superseded' : 'invalidated', node.activation_id);
    createActivation(store, taskId, id, task.graph_version, rounds.get(id) ?? 1);
    store.db.prepare("UPDATE nodes SET status='pending',output=NULL,route=NULL,output_operation=NULL WHERE task_id=? AND id=?").run(taskId, id);
  }
}
