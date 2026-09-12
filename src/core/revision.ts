import { randomUUID } from 'node:crypto';
import { canonicalJson, type TaskStore } from './store.ts';
import { createActivation, GraphPlan, resetIdleNode } from './graph.ts';
import { validateProposal } from './proposal.ts';
import { RuntimeError, type ContainerSpec, type LoopSpec, type NodeSpec, type Proposal } from './types.ts';

export interface GraphRevisionInput {
  baseVersion: number;
  reason: string;
  nodes: NodeSpec[];
  containers?: ContainerSpec[];
  loops?: LoopSpec[];
}

/** Apply a supervisor graph revision after the confirmed acceptance threshold is locked. */
export function applyRevision(store: TaskStore, taskId: string, input: GraphRevisionInput) {
  const task = store.task(taskId);
  if (task.accepted_proposal === null) throw new RuntimeError('invalid_command', 'Graph revision requires confirmed requirements');
  if (task.graph_version !== input.baseVersion) throw new RuntimeError('stale_graph', 'Revision must reference the current graph version');
  if (!input.reason.trim()) throw new RuntimeError('invalid_proposal', 'A revision reason is required');
  const accepted = JSON.parse((store.db.prepare('SELECT spec FROM proposals WHERE task_id=? AND version=?').get(taskId, task.accepted_proposal) as { spec: string }).spec) as Proposal;
  const current = JSON.parse((store.db.prepare('SELECT spec FROM graph_revisions WHERE task_id=? AND version=?').get(taskId, task.graph_version) as { spec: string }).spec) as Proposal;
  const next: Proposal = {
    ...current,
    requirementVersion: accepted.requirementVersion,
    summary: accepted.summary,
    acceptance: accepted.acceptance,
    nodes: input.nodes,
    ...((input.containers ?? current.containers) ? { containers: input.containers ?? current.containers } : {}),
    ...((input.loops ?? current.loops) ? { loops: input.loops ?? current.loops } : {}),
  };
  if (canonicalJson(next.acceptance) !== canonicalJson(accepted.acceptance)) throw new RuntimeError('invalid_proposal', 'Revision cannot change confirmed acceptance');
  validateProposal(next);
  for (const item of accepted.acceptance) {
    const prior = current.nodes.find(node => node.id === item.checkNode);
    const nextNode = next.nodes.find(node => node.id === item.checkNode);
    const confirmed = accepted.nodes.find(node => node.id === item.checkNode);
    if (!prior || !nextNode || !confirmed) throw new RuntimeError('invalid_proposal', 'Revision cannot remove a confirmed acceptance check');
    if (prior.kind !== nextNode.kind || prior.action !== nextNode.action || Boolean(prior.optional) !== Boolean(nextNode.optional)) {
      throw new RuntimeError('invalid_proposal', 'Revision cannot change a confirmed check action');
    }
    if (canonicalJson(prior.verifier ?? null) !== canonicalJson(nextNode.verifier ?? null)) {
      throw new RuntimeError('invalid_proposal', 'Revision cannot change confirmed verification rules');
    }
    if (canonicalJson(nextNode.input ?? null) !== canonicalJson(confirmed.input ?? null)) {
      throw new RuntimeError('invalid_proposal', 'Revision cannot change the confirmed input of an acceptance check');
    }
    for (const dependency of prior.dependsOn ?? []) {
      if (!(nextNode.dependsOn ?? []).includes(dependency)) throw new RuntimeError('invalid_proposal', 'Revision cannot remove a confirmed check dependency');
    }
  }
  const previous = new GraphPlan(current);
  const replacements = new Map<string, string[]>();
  for (const node of next.nodes) {
    const prior = previous.nodes.get(node.id);
    if (prior && !prior.optional && node.optional) throw new RuntimeError('invalid_proposal', 'A required node cannot become optional');
    if (prior && prior.kind !== node.kind) throw new RuntimeError('invalid_proposal', 'Node kind is part of its identity');
    if (node.replaces) {
      if (!previous.nodes.has(node.replaces) || next.nodes.some(item => item.id === node.replaces)) throw new RuntimeError('invalid_proposal', 'Replacement must name a retired node');
      replacements.set(node.replaces, [...(replacements.get(node.replaces) ?? []), node.id]);
    }
  }
  for (const [from, targets] of replacements) {
    if (targets.length !== 1) throw new RuntimeError('invalid_proposal', 'Reassignment of work must be unambiguous');
    if (!store.db.prepare('SELECT i.id FROM instances i JOIN nodes n ON n.instance_id=i.id WHERE n.task_id=? AND n.id=?').get(taskId, from)) {
      throw new RuntimeError('invalid_proposal', 'Reassignment must keep the original instance');
    }
  }
  const nextIds = new Set(next.nodes.map(node => node.id));
  for (const id of previous.nodes.keys()) {
    if (nextIds.has(id) || replacements.has(id)) continue;
    const instance = store.db.prepare('SELECT used,budget FROM instances WHERE task_id=? AND node_id=?').get(taskId, id) as { used: number; budget: number } | undefined;
    const status = (store.db.prepare('SELECT status FROM nodes WHERE task_id=? AND id=?').get(taskId, id) as { status: string }).status;
    if (instance && instance.used >= instance.budget && !['succeeded', 'skipped'].includes(status)) {
      throw new RuntimeError('invalid_proposal', 'Exhausted incomplete work cannot disappear from the graph');
    }
  }
  const changed = new Set<string>();
  for (const node of next.nodes) {
    const prior = previous.nodes.get(node.id);
    if (prior && canonicalJson({ ...prior, replaces: undefined }) !== canonicalJson({ ...node, replaces: undefined })) changed.add(node.id);
    if (!prior) changed.add(node.id);
  }
  for (const id of previous.nodes.keys()) if (!nextIds.has(id)) changed.add(id);
  const planned = new GraphPlan(next);
  const affected = new Set(changed);
  for (const id of changed) for (const dependent of planned.dependents(id)) affected.add(dependent);
  for (const id of affected) {
    if (store.db.prepare("SELECT id FROM operations WHERE task_id=? AND node_id=? AND (state IN ('intent','dispatched','unknown') OR worker_active=1)").get(taskId, id)) {
      throw new RuntimeError('revision_busy', 'Affected work must become idle before the revision applies');
    }
  }
  const version = task.graph_version + 1;
  store.db.prepare('INSERT INTO graph_revisions(task_id,version,spec,reason,base_version) VALUES(?,?,?,?,?)').run(taskId, version, canonicalJson(next), input.reason, input.baseVersion);
  store.db.prepare('UPDATE tasks SET graph_version=? WHERE id=?').run(version, taskId);
  if (task.phase === 'completed') {
    const { active_task } = store.db.prepare('SELECT active_task FROM runtime').get() as { active_task: string | null };
    store.db.prepare('UPDATE tasks SET phase=? WHERE id=?').run(active_task && active_task !== taskId ? 'queued' : 'running', taskId);
    if (!active_task) store.db.prepare('UPDATE runtime SET active_task=?').run(taskId);
  }
  for (const node of next.nodes) {
    const existing = store.db.prepare('SELECT instance_id FROM nodes WHERE task_id=? AND id=?').get(taskId, node.id) as { instance_id: string | null } | undefined;
    if (existing) {
      store.db.prepare('UPDATE nodes SET spec=? WHERE task_id=? AND id=?').run(canonicalJson(node), taskId, node.id);
      if (affected.has(node.id)) resetIdleNode(store, taskId, node.id, version, 1, ['pending', 'retired']);
      continue;
    }
    if (node.replaces) {
      const source = store.db.prepare('SELECT instance_id FROM nodes WHERE task_id=? AND id=?').get(taskId, node.replaces) as { instance_id: string | null };
      store.db.prepare("UPDATE nodes SET instance_id=NULL,status='retired' WHERE task_id=? AND id=?").run(taskId, node.replaces);
      store.db.prepare('INSERT INTO nodes(task_id,id,spec,instance_id) VALUES(?,?,?,?)').run(taskId, node.id, canonicalJson(node), source.instance_id);
      if (source.instance_id) store.db.prepare('UPDATE instances SET node_id=? WHERE id=?').run(node.id, source.instance_id);
      createActivation(store, taskId, node.id, version);
      continue;
    }
    const instanceId = node.kind === 'agent' ? randomUUID() : null;
    store.db.prepare('INSERT INTO nodes(task_id,id,spec,instance_id) VALUES(?,?,?,?)').run(taskId, node.id, canonicalJson(node), instanceId);
    if (instanceId) store.db.prepare('INSERT INTO instances(id,task_id,node_id) VALUES(?,?,?)').run(instanceId, taskId, node.id);
    createActivation(store, taskId, node.id, version);
  }
  for (const id of previous.nodes.keys()) {
    if (!nextIds.has(id) && !replacements.has(id)) store.db.prepare("UPDATE nodes SET status='retired' WHERE task_id=? AND id=?").run(taskId, id);
  }
  const cursor = store.event(taskId, 'graph.revised', { graphVersion: version, reason: input.reason, baseVersion: input.baseVersion });
  return { version, cursor };
}
