import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { addInstanceUsage } from './context.ts';
import { conversationForTask, pendingMessages, recordConversationOutput } from './conversation.ts';
import { loadGraph, reactivate } from './graph.ts';
import { canonicalJson, type TaskStore } from './store.ts';
import { closeUserWaitForOperation, openUserWait } from './time-ledger.ts';
import { isReworkDecision, type VerificationDecision } from './verification.ts';
import { RuntimeError, type Json, type NodeSpec, type Operation, type OperationResult, type Proposal } from './types.ts';

interface NodeRow {
  id: string;
  task_id: string;
  spec: string;
  instance_id: string | null;
  status: string;
  output: string | null;
  activation_id: string;
}

interface OperationRow {
  id: string;
  task_id: string;
  node_id: string;
  instance_id: string | null;
  generation: number;
  spec: string;
  state: string;
  reserved: number;
  worker_active: number;
  result: string | null;
  usage: string | null;
  activation_id: string;
}

export interface SettlementHooks {
  block(node: NodeRow, kind: string, data: Json, operationId?: string | null): void;
  advance(taskId: string): void;
}

function handleRework(store: TaskStore, operation: Operation, result: OperationResult, hooks: SettlementHooks) {
  const graph = loadGraph(store, operation.taskId);
  const loops = graph.plan.loops.filter(loop => loop.from === operation.nodeId);
  const decision = result.output as unknown as VerificationDecision;
  const targets = loops.length ? loops.map(loop => loop.to) : decision.subjects.map(subject => subject.nodeId);
  let halt = false;
  for (const target of new Set(targets.length ? targets : [operation.nodeId])) {
    const previous = store.db.prepare(`SELECT result FROM operations
      WHERE task_id=? AND node_id=? AND state='succeeded' AND id!=? ORDER BY rowid DESC LIMIT 1`)
      .get(operation.taskId, operation.nodeId, operation.id) as { result: string } | undefined;
    const previousOutput = previous ? JSON.parse(previous.result) as OperationResult : undefined;
    const previousIds = new Set(isReworkDecision(previousOutput?.output ?? null)
      ? (previousOutput!.output as unknown as VerificationDecision).blockers.map(item => item.id)
      : []);
    const currentIds = new Set(decision.blockers.map(item => item.id));
    const progress = !currentIds.has('invalid_evidence') && [...previousIds].some(id => !currentIds.has(id));
    if (progress) store.db.prepare('UPDATE nodes SET stall_count=0 WHERE task_id=? AND id=?').run(operation.taskId, target);
    else store.db.prepare('UPDATE nodes SET stall_count=stall_count+1 WHERE task_id=? AND id=?').run(operation.taskId, target);
    const { stall_count } = store.db.prepare('SELECT stall_count FROM nodes WHERE task_id=? AND id=?')
      .get(operation.taskId, target) as { stall_count: number };
    if (stall_count >= 3) halt = true;
  }
  const node = store.db.prepare('SELECT * FROM nodes WHERE task_id=? AND id=?')
    .get(operation.taskId, operation.nodeId) as unknown as NodeRow;
  if (halt) {
    const attempts = store.db.prepare('SELECT node_id,round,state FROM activations WHERE task_id=? AND node_id IN ('
      + targets.map(() => '?').join(',') + ') ORDER BY round,rowid')
      .all(operation.taskId, ...(targets.length ? targets : [operation.nodeId])) as { node_id: string; round: number; state: string }[];
    hooks.block(node, 'stalled', {
      reason: 'Three consecutive rounds made no substantial progress',
      resume: targets,
      blockers: decision.blockers,
      attempts,
      evidence: decision.blockers.flatMap(item => item.evidence),
    }, operation.id);
    return;
  }
  if (!loops.length) {
    hooks.block(node, 'rework', { output: result.output, resume: targets }, operation.id);
    return;
  }
  reactivate(store, operation.taskId, loops.map(loop => loop.to));
  store.event(operation.taskId, 'graph.rework', { from: operation.nodeId, to: loops.map(loop => loop.to) });
}

export function settleOperation(
  store: TaskStore,
  operation: Operation,
  result: OperationResult,
  hooks: SettlementHooks,
) {
  if (!result || !['completed', 'continue', 'waiting', 'failed', 'skipped'].includes(result.outcome)) {
    throw new RuntimeError('invalid_result', 'Unexpected operation outcome');
  }
  canonicalJson(result);
  const row = store.db.prepare('SELECT * FROM operations WHERE id=?').get(operation.id) as unknown as OperationRow;
  if (row.state === 'succeeded') {
    if (row.result !== canonicalJson(result)) throw new RuntimeError('result_conflict', 'Operation already has a different result');
    return;
  }
  if (!['dispatched', 'unknown'].includes(row.state)) throw new RuntimeError('invalid_operation', 'Operation was not dispatched');
  const currentNode = store.db.prepare('SELECT activation_id FROM nodes WHERE task_id=? AND id=?')
    .get(operation.taskId, operation.nodeId) as { activation_id: string };
  if (currentNode.activation_id !== operation.activationId) throw new RuntimeError('stale_activation', 'Operation belongs to a replaced activation');
  if (row.result) {
    const previous = JSON.parse(row.result) as OperationResult;
    if (canonicalJson({ ...previous, usage: undefined }) !== canonicalJson({ ...result, usage: undefined })) {
      throw new RuntimeError('result_conflict', 'Known result cannot change during usage reconciliation');
    }
  }
  const usage = operation.kind === 'agent'
    ? result.usage
    : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  if (!usage) {
    recordConversationOutput(store, operation, result);
    store.db.prepare("UPDATE operations SET state='unknown',worker_active=0,result=? WHERE id=?")
      .run(canonicalJson(result), operation.id);
    store.db.prepare("UPDATE nodes SET status='blocked' WHERE task_id=? AND id=?").run(operation.taskId, operation.nodeId);
    store.db.prepare("UPDATE questions SET status='resolved',answer=? WHERE operation_id=? AND kind='recovery' AND status='open'")
      .run(canonicalJson({ result }), operation.id);
    closeUserWaitForOperation(store, operation.id);
    if (!store.db.prepare("SELECT id FROM questions WHERE operation_id=? AND kind='unknown_usage' AND status='open'").get(operation.id)) {
      store.db.prepare('INSERT INTO questions(id,task_id,node_id,operation_id,kind,data) VALUES(?,?,?,?,?,?)')
        .run(randomUUID(), operation.taskId, operation.nodeId, operation.id, 'unknown_usage', canonicalJson({ reason: 'Agent returned no authoritative usage' }));
      openUserWait(store, operation.taskId, operation.nodeId);
      store.event(operation.taskId, 'operation.unknown', { operationId: operation.id, reason: 'unknown_usage' });
    }
    return;
  }
  const values = [usage.input, usage.output, usage.cacheRead, usage.cacheWrite];
  const total = values.reduce((a, b) => a + b, 0);
  if (values.some(value => !Number.isSafeInteger(value) || value < 0) || !Number.isSafeInteger(total)) {
    throw new RuntimeError('invalid_usage', 'Invalid disjoint token counts');
  }
  const proposalRow = store.db.prepare('SELECT spec FROM proposals WHERE task_id=? AND version=?')
    .get(operation.taskId, operation.proposalVersion) as { spec: string } | undefined;
  const proposal = proposalRow
    ? JSON.parse(proposalRow.spec) as Proposal
    : { requirementVersion: 1, summary: '', acceptance: [] as Proposal['acceptance'], nodes: [] as Proposal['nodes'] };
  const nodeSpec = JSON.parse((store.db.prepare('SELECT spec FROM nodes WHERE task_id=? AND id=?')
    .get(operation.taskId, operation.nodeId) as { spec: string }).spec) as NodeSpec;
  if (new Set(result.artifacts?.map(artifact => artifact.id)).size !== (result.artifacts?.length ?? 0)
    || result.artifacts?.some(artifact => !artifact.id.trim() || !isAbsolute(artifact.path) || !/^[a-f0-9]{64}$/.test(artifact.digest))) {
    throw new RuntimeError('invalid_evidence', 'Artifacts require unique IDs, absolute paths and SHA-256 digests');
  }
  if (result.outcome === 'skipped' && !nodeSpec.optional) throw new RuntimeError('invalid_result', 'Only a predeclared optional node may skip work');
  if ((nodeSpec.routes && result.outcome === 'completed' && !nodeSpec.routes.includes(result.route!))
    || (result.route !== undefined && !nodeSpec.routes?.includes(result.route))) {
    throw new RuntimeError('invalid_result', 'Router must return a declared case');
  }
  const rework = result.outcome === 'completed' && isReworkDecision(result.output);
  if (result.outcome === 'completed' && !rework && proposal.acceptance.some(item =>
    item.checkNode === operation.nodeId && !result.evidence?.some(evidence => evidence.acceptanceId === item.id))) {
    throw new RuntimeError('invalid_evidence', 'Completed check is missing required acceptance evidence');
  }
  if (rework && result.evidence?.length) throw new RuntimeError('invalid_evidence', 'Rework cannot carry acceptance evidence');
  if (result.evidence?.length && result.outcome !== 'completed') throw new RuntimeError('invalid_evidence', 'Only a completed check may produce acceptance evidence');
  for (const evidence of result.evidence ?? []) {
    if (operation.kind !== 'program'
      || !proposal.acceptance.some(item => item.id === evidence.acceptanceId && item.checkNode === operation.nodeId)) {
      throw new RuntimeError('invalid_evidence', 'Evidence must come from the assigned program check');
    }
    if (!evidence.summary.trim() || !isAbsolute(evidence.artifact.path) || !/^[a-f0-9]{64}$/.test(evidence.artifact.digest)) {
      throw new RuntimeError('invalid_evidence', 'Evidence requires a summary, absolute artifact path and SHA-256 digest');
    }
    store.db.prepare(`INSERT INTO evidence(id,task_id,node_id,operation_id,acceptance_id,proposal_version,requirement_version,data,activation_id,commit_sha)
      VALUES(?,?,?,?,?,?,?,?,?,?)`).run(
        randomUUID(), operation.taskId, operation.nodeId, operation.id, evidence.acceptanceId,
        operation.proposalVersion, operation.requirementVersion, canonicalJson(evidence), operation.activationId,
        store.task(operation.taskId).integration_sha,
      );
  }
  store.db.prepare("UPDATE operations SET state='succeeded',reserved=0,worker_active=0,result=?,usage=?,settled_at=COALESCE(settled_at,?) WHERE id=?")
    .run(canonicalJson(result), canonicalJson(usage), Date.now(), operation.id);
  if (operation.instanceId) {
    addInstanceUsage(store, operation.instanceId, total);
    const account = store.db.prepare('SELECT model,models_used FROM instances WHERE id=?')
      .get(operation.instanceId) as { model: string | null; models_used: string };
    const used = JSON.parse(account.models_used) as string[];
    if (account.model && !used.includes(account.model)) {
      store.db.prepare('UPDATE instances SET models_used=? WHERE id=?')
        .run(canonicalJson([...used, account.model]), operation.instanceId);
    }
  }
  store.db.prepare("UPDATE questions SET status='resolved',answer=? WHERE operation_id=? AND status='open'")
    .run(canonicalJson({ result }), operation.id);
  closeUserWaitForOperation(store, operation.id);
  if (result.outcome === 'waiting') {
    if (!result.question?.prompt.trim()) throw new RuntimeError('invalid_result', 'Waiting requires a question');
    const node = store.db.prepare('SELECT * FROM nodes WHERE task_id=? AND id=?')
      .get(operation.taskId, operation.nodeId) as unknown as NodeRow;
    if (result.question.grant) hooks.block(node, 'permission', { grant: result.question.grant }, operation.id);
    else hooks.block(node, 'waiting', result.question.data ?? { prompt: result.question.prompt }, operation.id);
  }
  const conversation = nodeSpec.role === 'master' && operation.kind === 'agent'
    ? conversationForTask(store, operation.taskId)
    : undefined;
  recordConversationOutput(store, operation, result);
  const queuedAfter = conversation ? pendingMessages(store, conversation.id, 1).length : 0;
  const nextStatus = conversation && result.outcome === 'completed' && queuedAfter
    ? 'pending'
    : result.outcome === 'completed'
      ? 'succeeded'
      : result.outcome === 'continue'
        ? 'pending'
        : result.outcome;
  store.db.prepare('UPDATE nodes SET status=?,output=?,route=?,output_version=output_version+1,output_operation=? WHERE task_id=? AND id=?')
    .run(nextStatus, canonicalJson(result.output), result.route ?? null, operation.id, operation.taskId, operation.nodeId);
  if (result.outcome === 'failed' && !nodeSpec.optional) {
    const node = store.db.prepare('SELECT * FROM nodes WHERE task_id=? AND id=?')
      .get(operation.taskId, operation.nodeId) as unknown as NodeRow;
    hooks.block(node, 'execution_failed', { output: result.output }, operation.id);
  }
  if (total > row.reserved) {
    const node = store.db.prepare('SELECT * FROM nodes WHERE task_id=? AND id=?')
      .get(operation.taskId, operation.nodeId) as unknown as NodeRow;
    hooks.block(node, 'reservation_exceeded', { reserved: row.reserved, actual: total }, operation.id);
  }
  store.event(operation.taskId, 'operation.result', { operationId: operation.id, result });
  store.db.prepare('UPDATE activations SET state=(SELECT status FROM nodes WHERE task_id=? AND id=?) WHERE id=?')
    .run(operation.taskId, operation.nodeId, operation.activationId);
  if (rework) handleRework(store, operation, result, hooks);
  else if (result.outcome === 'completed' && proposal.acceptance.some(item => item.checkNode === operation.nodeId)) {
    for (const loop of loadGraph(store, operation.taskId).plan.loops.filter(item => item.from === operation.nodeId)) {
      store.db.prepare('UPDATE nodes SET stall_count=0 WHERE task_id=? AND id=?').run(operation.taskId, loop.to);
    }
  }
  hooks.advance(operation.taskId);
}
