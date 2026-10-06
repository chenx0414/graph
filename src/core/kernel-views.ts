import { usageSourceOf } from '../runtime/call-broker.ts';
import type { KernelStore } from './kernel-store.ts';
import type { NodePromptView } from './node-prompt.ts';
import { listNodeEntries } from './node-run.ts';
import { explainEdge, explainModule } from './kernel-explain.ts';
import { RuntimeError } from './types.ts';

export function kernelGraphView(kernel: KernelStore, graphId: string) {
  const revision = kernel.latestRevision(graphId);
  if (!revision) return null;
  const definition = revision.definition;
  return {
    definition, revision: revision.version,
    edges: Object.keys(definition.edges).map(id => explainEdge(kernel, graphId, id)),
    modules: Object.keys(definition.modules).map(id => ({ ...explainModule(kernel, graphId, id), definition: definition.modules[id] })),
    nodes: kernel.listNodes(graphId),
  };
}

export function kernelNodeRun(kernel: KernelStore, graphId: string, nodeId: string, query: { after?: number; before?: number; limit?: number }) {
  const row = kernel.listNodes(graphId).find(node => node.nodeId === nodeId);
  const definition = kernel.latestRevision(graphId)?.definition.nodes[nodeId];
  if (!row || !definition) throw new RuntimeError('not_found', `Unknown node ${nodeId}`);
  const binding = kernel.db.prepare('SELECT model_id,role FROM kernel_node_bindings WHERE task_id=? AND node_id=?').get(graphId, nodeId) as { model_id: string; role: string | null } | undefined;
  const state = kernel.db.prepare('SELECT used,reserved FROM kernel_node_state WHERE task_id=? AND node_id=?').get(graphId, nodeId) as { used: number; reserved: number } | undefined;
  const session = kernel.db.prepare('SELECT session_id,session_file FROM node_sessions WHERE instance_id=?').get(row.instanceId) as { session_id: string; session_file: string | null } | undefined;
  const executions = kernel.db.prepare('SELECT id,attempt,state,submission_id,started_at,ended_at,retries_used,resubmits_used,token_budget,token_reservation,waiting_slot FROM kernel_executions WHERE task_id=? AND node_id=? ORDER BY rowid').all(graphId, nodeId) as { id: string; attempt: number; state: string; submission_id: string | null; started_at: number; ended_at: number | null; retries_used: number; resubmits_used: number; token_budget: string | null; token_reservation: number; waiting_slot: number }[];
  const capability = kernel.db.prepare('SELECT loaded FROM node_capabilities WHERE task_id=? AND node_id=? ORDER BY seq DESC LIMIT 1').get(graphId, nodeId) as { loaded: string } | undefined;
  const loaded = capability ? JSON.parse(capability.loaded) : null;
  const calls = kernel.providerCalls(graphId, nodeId);
  const latestBudget = executions.at(-1)?.token_budget;
  const budget = latestBudget ? JSON.parse(latestBudget) as { budget: number; unlimited: boolean } : null;
  const settled = executions.filter(item => item.ended_at !== null);
  return {
    taskId: graphId, nodeId, context: null,
    node: { id: nodeId, kind: 'agent', action: definition.task, role: binding?.role ?? null, status: row.status, definitionVersion: definition.recipe },
    instance: { id: row.instanceId, model: binding?.model_id ?? null, definitionVersion: definition.recipe ?? null,
      used: state?.used ?? 0, budget: budget?.unlimited ? null : budget?.budget ?? null, unlimited: budget?.unlimited ?? false, reserved: state?.reserved ?? 0, modelsUsed: [...new Set(calls.flatMap(call => call.model ? [call.model.id] : []))] },
    session: session ? { sessionId: session.session_id, sessionFile: session.session_file } : null,
    capabilities: loaded?.facts ?? [], capabilityDigest: loaded?.digest ?? null, capabilityUsage: [],
    operations: executions.map(item => ({ ...item, activationId: item.id, workerActive: item.state === 'running', waitingSlot: item.waiting_slot === 1,
      reserved: item.token_reservation, waitingMs: null, runMs: null, elapsedMs: item.ended_at === null ? null : item.ended_at - item.started_at,
      dispatchedAt: item.started_at, settledAt: item.ended_at, result: null, usage: null })), invocations: calls.map(call => ({ id: call.id, operationId: call.executionId, model: call.model?.id ?? null,
      modelIdentity: call.model?.identity ?? null, provider: call.model?.provider ?? null, state: call.state,
      reserved: ['inflight', 'unknown'].includes(call.state) ? call.reserved : 0,
      usage: call.usage, usageSource: usageSourceOf(call.usage), cost: null, purpose: 'node',
      dispatchedAt: call.createdAt, settledAt: call.settledAt })), questions: [], evidence: [],
    timing: { totalMs: settled.length ? settled.reduce((total, item) => total + item.ended_at! - item.started_at, 0) : null,
      runMs: null, waitingMs: null, pauseMs: null, userWaitMs: null, inProgress: executions.some(item => item.state === 'running') },
    ...listNodeEntries(kernel.store, graphId, nodeId, query), phase: kernel.store.task(graphId).phase,
  };
}

export function kernelNodePrompt(kernel: KernelStore, graphId: string, nodeId: string): NodePromptView {
  const node = kernel.listNodes(graphId).find(item => item.nodeId === nodeId);
  const definition = kernel.latestRevision(graphId)?.definition.nodes[nodeId];
  if (!node || !definition) throw new RuntimeError('not_found', `Unknown node ${nodeId}`);
  const record = kernel.db.prepare('SELECT execution_id,system_prompt,tools,created_at FROM kernel_prompts WHERE task_id=? AND node_id=? ORDER BY seq DESC LIMIT 1').get(graphId, nodeId) as { execution_id: string; system_prompt: string; tools: string; created_at: number } | undefined;
  const first = kernel.db.prepare("SELECT text FROM node_entries WHERE task_id=? AND node_id=? AND role='user' ORDER BY seq LIMIT 1").get(graphId, nodeId) as { text: string } | undefined;
  const session = kernel.db.prepare('SELECT session_file FROM node_sessions WHERE instance_id=?').get(node.instanceId) as { session_file: string | null } | undefined;
  const binding = kernel.db.prepare('SELECT model_id,role FROM kernel_node_bindings WHERE task_id=? AND node_id=?').get(graphId, nodeId) as { model_id: string; role: string | null } | undefined;
  return {
    taskId: graphId, nodeId, kind: 'agent', action: definition.task, role: binding?.role ?? null, definitionVersion: definition.recipe ?? null,
    model: binding?.model_id ?? null, status: node.status,
    recorded: record ? { operationId: record.execution_id, at: record.created_at, text: record.system_prompt, tools: record.tools } : null,
    briefing: first ? { text: first.text, sessionFile: session?.session_file ?? '' } : null,
    notes: record ? [] : ['尚无实际模型发送记录。'],
  };
}
