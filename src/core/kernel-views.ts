import { nativePauseMs } from './time-ledger.ts';
import type { GraphDefinition } from './interface-spec.ts';
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

/** Compact conversation cards read native node facts without loading session pages. */
export function kernelConversationNodes(kernel: KernelStore, graphId: string) {
  const rows = kernel.db.prepare(`SELECT n.node_id,n.spec,n.status,b.role,b.model_id,s.used,e.token_budget
    FROM kernel_nodes n LEFT JOIN kernel_node_bindings b ON b.task_id=n.task_id AND b.node_id=n.node_id
    LEFT JOIN kernel_node_state s ON s.task_id=n.task_id AND s.node_id=n.node_id
    LEFT JOIN kernel_executions e ON e.rowid=(SELECT MAX(rowid) FROM kernel_executions WHERE task_id=n.task_id AND node_id=n.node_id)
    WHERE n.task_id=? ORDER BY n.rowid`).all(graphId) as {
      node_id: string; spec: string; status: string; role: string | null; model_id: string | null;
      used: number | null; token_budget: string | null;
    }[];
  return rows.map(row => {
    const spec = JSON.parse(row.spec) as GraphDefinition['nodes'][string];
    const budget = row.token_budget ? JSON.parse(row.token_budget) as { budget: number; unlimited: boolean } : null;
    return { id: row.node_id, kind: 'agent' as const, role: row.role, status: row.status, used: row.used ?? 0,
      unlimited: budget?.unlimited ?? false, budget: budget?.unlimited ? null : budget?.budget ?? null,
      model: row.model_id, definitionVersion: spec.recipe ?? null, stallCount: 0, outputVersion: 0 };
  });
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
      authorizedBudget: kernel.authorizedBudget(graphId, nodeId),
      used: state?.used ?? 0, budget: budget?.unlimited ? null : budget?.budget ?? null, unlimited: budget?.unlimited ?? false, reserved: state?.reserved ?? 0, modelsUsed: [...new Set(calls.flatMap(call => call.model ? [call.model.id] : []))] },
    session: session ? { sessionId: session.session_id, sessionFile: session.session_file } : null,
    capabilities: loaded?.facts ?? [], capabilityDigest: loaded?.digest ?? null, capabilityUsage: [],
    operations: executions.map(item => ({ ...item, activationId: item.id, workerActive: item.state === 'running', waitingSlot: item.waiting_slot === 1,
      reserved: item.token_reservation, tokenBudget: item.token_budget ? JSON.parse(item.token_budget) as { budget: number; unlimited: boolean } : null, waitingMs: null, runMs: null, elapsedMs: item.ended_at === null ? null : item.ended_at - item.started_at,
      dispatchedAt: item.started_at, settledAt: item.ended_at, result: null, usage: null })), invocations: calls.map(call => ({ id: call.id, operationId: call.executionId, model: call.model?.id ?? null,
      modelIdentity: call.model?.identity ?? null, provider: call.model?.provider ?? null, state: call.state,
      reserved: ['inflight', 'unknown'].includes(call.state) ? call.reserved : 0,
      usage: call.usage, usageSource: usageSourceOf(call.usage), cost: call.cost, purpose: call.purpose,
      dispatchedAt: call.createdAt, settledAt: call.settledAt })), questions: [], evidence: [],
    timing: { totalMs: settled.length ? settled.reduce((total, item) => total + item.ended_at! - item.started_at, 0) : null,
      runMs: null, waitingMs: null, pauseMs: nativePauseMs(kernel.store, graphId, nodeId), userWaitMs: null, inProgress: executions.some(item => item.state === 'running') },
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


/** Config deletion guard: pending declarations and the models actual turns still use. */
export function kernelModelsInUse(kernel: KernelStore): string[] {
  const used = new Set<string>();
  const revisions = new Map<string, GraphDefinition>();
  const native = kernel.db.prepare(`SELECT n.task_id,n.node_id,n.spec,b.model_id,e.revision_version,e.state
    FROM kernel_nodes n JOIN tasks t ON t.id=n.task_id
    LEFT JOIN kernel_node_bindings b ON b.task_id=n.task_id AND b.node_id=n.node_id
    LEFT JOIN kernel_executions e ON e.rowid=(SELECT MAX(x.rowid) FROM kernel_executions x WHERE x.task_id=n.task_id AND x.node_id=n.node_id)
    WHERE n.status!='retired' AND t.phase NOT IN ('completed','stopped','abandoned')`).all() as {
      task_id: string; node_id: string; spec: string; model_id: string | null; revision_version: number | null; state: string | null;
    }[];

  for (const row of native) {
    const configured = JSON.parse(row.spec) as { model?: string; recipe: string };
    if (configured.model) used.add(configured.model);
    if (!row.model_id) continue;
    if (row.state === 'running' || row.revision_version === null) { used.add(row.model_id); continue; }
    const key = `${row.task_id}:${row.revision_version}`;
    if (!revisions.has(key)) {
      const revision = kernel.revision(row.task_id, row.revision_version);
      if (revision) revisions.set(key, revision.definition);
    }
    const previous = revisions.get(key)?.nodes[row.node_id];
    // A patch applies to the next turn. Keep the frozen active model, or the
    // selected fallback of an unchanged declaration; not an obsolete idle binding.
    if (!previous || configured.model === previous.model && configured.recipe === previous.recipe) used.add(row.model_id);
  }
  return [...used];
}
