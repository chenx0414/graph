import { canonicalJson } from './store.ts';
import { nativePauseMs } from './time-ledger.ts';
import type { GraphDefinition } from './interface-spec.ts';
import { usageSourceOf } from '../runtime/call-broker.ts';
import type { KernelStore } from './kernel-store.ts';
import type { NodePromptView, NodeConfigurations, NodeConfigurationSnapshot } from './node-prompt.ts';
import { listNodeEntries } from './node-run.ts';
import { explainEdge, explainModule } from './kernel-explain.ts';
import { RuntimeError } from './types.ts';

/** A requested pause is settled only after agent turns and host commands stop. */
export function kernelHasActiveWork(kernel: KernelStore, graphId: string): boolean {
  return Boolean(kernel.db.prepare(`SELECT 1 WHERE
    EXISTS(SELECT 1 FROM kernel_executions WHERE task_id=? AND state='running') OR
    EXISTS(SELECT 1 FROM kernel_module_operations WHERE task_id=? AND worker_active=1)`)
    .get(graphId, graphId));
}

export function kernelGraphView(kernel: KernelStore, graphId: string) {
  const revision = kernel.latestRevision(graphId);
  if (!revision) return null;
  const definition = revision.definition;
  return {
    graphId, definition, revision: revision.version,
    edges: Object.keys(definition.edges).map(id => explainEdge(kernel, graphId, id, undefined, { limit: 1 })),
    modules: Object.keys(definition.modules).map(id => ({ ...explainModule(kernel, graphId, id, { includeTransitions: false }), definition: definition.modules[id] })),
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

/** History includes retired nodes; the active graph projection deliberately excludes them. */
function historicalNode(kernel: KernelStore, graphId: string, nodeId: string) {
  const row = kernel.db.prepare('SELECT instance_id AS instanceId,status,spec FROM kernel_nodes WHERE task_id=? AND node_id=?')
    .get(graphId, nodeId) as { instanceId: string; status: string; spec: string } | undefined;
  return row && { ...row, definition: JSON.parse(row.spec) as GraphDefinition['nodes'][string] };
}

/** Compare this node's configuration, not unrelated changes to the graph revision. */
function nodeConfigurations(kernel: KernelStore, graphId: string, nodeId: string, executionId?: string): NodeConfigurations {
  const execution = kernel.db.prepare(`SELECT revision_version FROM kernel_executions WHERE task_id=? AND node_id=?
    ${executionId ? 'AND id=?' : ''} ORDER BY rowid DESC LIMIT 1`)
    .get(...(executionId ? [graphId, nodeId, executionId] : [graphId, nodeId])) as { revision_version: number } | undefined;
  const snapshot = (revision: ReturnType<KernelStore['latestRevision']>): NodeConfigurationSnapshot | null => {
    const definition = revision?.definition.nodes[nodeId];
    return revision && definition ? { revision: revision.version, definition, defaults: revision.definition.defaults } : null;
  };
  const current = execution ? snapshot(kernel.revision(graphId, execution.revision_version)) : null;
  const next = snapshot(kernel.latestRevision(graphId));
  // Revisions are stored canonically; revision numbers alone do not mean a node changed.
  const pending = current !== null && canonicalJson([current.definition, current.defaults ?? null]) !== canonicalJson([next?.definition ?? null, next?.defaults ?? null]);
  return { current, next, pending };
}

export function kernelNodeRun(kernel: KernelStore, graphId: string, nodeId: string, query: import('./node-run.ts').NodeEntryQuery) {
  const row = historicalNode(kernel, graphId, nodeId);
  const definition = row?.definition;
  if (!row || !definition) throw new RuntimeError('not_found', `Unknown node ${nodeId}`);
  const binding = kernel.db.prepare('SELECT model_id,role,environment FROM kernel_node_bindings WHERE task_id=? AND node_id=?').get(graphId, nodeId) as { model_id: string; role: string | null; environment: string | null } | undefined;
  const state = kernel.db.prepare('SELECT used,reserved FROM kernel_node_state WHERE task_id=? AND node_id=?').get(graphId, nodeId) as { used: number; reserved: number } | undefined;
  const session = kernel.db.prepare('SELECT session_id,session_file FROM node_sessions WHERE instance_id=?').get(row.instanceId) as { session_id: string; session_file: string | null } | undefined;
  const now = Date.now();
  const executions = (kernel.db.prepare('SELECT id,attempt,state,submission_id,started_at,ended_at,retries_used,resubmits_used,token_budget,token_reservation,waiting_slot,run_ms,waiting_ms,run_since,waiting_since FROM kernel_executions WHERE task_id=? AND node_id=? ORDER BY rowid').all(graphId, nodeId) as { id: string; attempt: number; state: string; submission_id: string | null; started_at: number; ended_at: number | null; retries_used: number; resubmits_used: number; token_budget: string | null; token_reservation: number; waiting_slot: number; run_ms: number | null; waiting_ms: number | null; run_since: number | null; waiting_since: number | null }[])
    .map(({ run_ms, waiting_ms, run_since, waiting_since, ...execution }) => ({ ...execution,
      runMs: run_ms === null ? null : run_ms + (run_since === null ? 0 : Math.max(0, now - run_since)),
      waitingMs: waiting_ms === null ? null : waiting_ms + (waiting_since === null ? 0 : Math.max(0, now - waiting_since)),
    }));
  const capability = kernel.db.prepare('SELECT loaded FROM node_capabilities WHERE task_id=? AND node_id=? ORDER BY seq DESC LIMIT 1').get(graphId, nodeId) as { loaded: string } | undefined;
  const loaded = capability ? JSON.parse(capability.loaded) : null;
  const calls = kernel.providerCalls(graphId, nodeId);
  const latestBudget = executions.at(-1)?.token_budget;
  const budget = latestBudget ? JSON.parse(latestBudget) as { budget: number; unlimited: boolean } : null;
  const configurations = nodeConfigurations(kernel, graphId, nodeId);
  // Every recorded Pi start is an actual invocation, even when a later provider
  // response reuses a tool call ID. Results and transcript page limits do not affect this total.
  const toolCallCount = (kernel.db.prepare(`SELECT COUNT(*) AS count FROM node_entries
    WHERE task_id=? AND node_id=? AND role='tool' AND kind='call'`).get(graphId, nodeId) as { count: number }).count;
  const settled = executions.filter(item => item.ended_at !== null);
  const totalMeasured = (field: 'runMs' | 'waitingMs') => executions.length && executions.every(item => item[field] !== null)
    ? executions.reduce((total, item) => total + item[field]!, 0) : null;
  return {
    taskId: graphId, nodeId, context: null, configurations, toolCallCount,
    environment: binding?.environment ? JSON.parse(binding.environment) as { revision: number; workspace: string; base: string; access: object } : null,
    node: { id: nodeId, kind: 'agent', action: definition.task, role: binding?.role ?? null, status: row.status, definitionVersion: definition.recipe },
    instance: { id: row.instanceId, model: binding?.model_id ?? null, definitionVersion: configurations.current?.definition.recipe ?? null,
      authorizedBudget: kernel.authorizedBudget(graphId, nodeId),
      used: state?.used ?? 0, budget: budget?.unlimited ? null : budget?.budget ?? null, unlimited: budget?.unlimited ?? false, reserved: state?.reserved ?? 0, modelsUsed: [...new Set(calls.flatMap(call => call.model ? [call.model.id] : []))] },
    session: session ? { sessionId: session.session_id, sessionFile: session.session_file } : null,
    capabilities: loaded?.facts ?? [], capabilityDigest: loaded?.digest ?? null, capabilityUsage: [],
    operations: executions.map(item => ({ ...item, activationId: item.id, workerActive: item.state === 'running', waitingSlot: item.waiting_slot === 1,
      reserved: item.token_reservation, tokenBudget: item.token_budget ? JSON.parse(item.token_budget) as { budget: number; unlimited: boolean } : null, elapsedMs: item.ended_at === null ? null : item.ended_at - item.started_at,
      dispatchedAt: item.started_at, settledAt: item.ended_at, result: null, usage: null })), invocations: calls.map(call => ({ id: call.id, operationId: call.executionId, model: call.model?.id ?? null,
      modelIdentity: call.model?.identity ?? null, provider: call.model?.provider ?? null, state: call.state,
      reserved: ['inflight', 'unknown'].includes(call.state) ? call.reserved : 0,
      usage: call.usage, usageSource: usageSourceOf(call.usage), cost: call.cost, purpose: call.purpose,
      dispatchedAt: call.createdAt, settledAt: call.settledAt })), questions: [], evidence: [],
    timing: { totalMs: settled.length ? settled.reduce((total, item) => total + item.ended_at! - item.started_at, 0) : null,
      runMs: totalMeasured('runMs'), waitingMs: totalMeasured('waitingMs'), pauseMs: nativePauseMs(kernel.store, graphId, nodeId), userWaitMs: null, inProgress: executions.some(item => item.state === 'running') },
    ...listNodeEntries(kernel.store, graphId, nodeId, query), phase: kernel.store.task(graphId).phase,
  };
}

export function kernelNodePrompt(kernel: KernelStore, graphId: string, nodeId: string): NodePromptView {
  const node = historicalNode(kernel, graphId, nodeId);
  const definition = node?.definition;
  if (!node || !definition) throw new RuntimeError('not_found', `Unknown node ${nodeId}`);
  const record = kernel.db.prepare('SELECT execution_id,system_prompt,tools,created_at FROM kernel_prompts WHERE task_id=? AND node_id=? ORDER BY seq DESC LIMIT 1').get(graphId, nodeId) as { execution_id: string; system_prompt: string; tools: string; created_at: number } | undefined;
  const first = kernel.db.prepare("SELECT text FROM node_entries WHERE task_id=? AND node_id=? AND role='user' ORDER BY seq LIMIT 1").get(graphId, nodeId) as { text: string } | undefined;
  const session = kernel.db.prepare('SELECT session_file FROM node_sessions WHERE instance_id=?').get(node.instanceId) as { session_file: string | null } | undefined;
  const binding = kernel.db.prepare('SELECT model_id,role,environment FROM kernel_node_bindings WHERE task_id=? AND node_id=?').get(graphId, nodeId) as { model_id: string; role: string | null } | undefined;
  const configurations = nodeConfigurations(kernel, graphId, nodeId);
  const recordedConfiguration = record ? nodeConfigurations(kernel, graphId, nodeId, record.execution_id).current : null;
  const recordedCall = record ? kernel.providerCalls(graphId, nodeId).findLast(call => call.executionId === record.execution_id) : null;
  return {
    taskId: graphId, nodeId, kind: 'agent', action: recordedConfiguration?.definition.task ?? definition.task, role: binding?.role ?? null,
    definitionVersion: recordedConfiguration?.definition.recipe ?? definition.recipe ?? null,
    model: record ? recordedCall?.model?.id ?? null : null, status: node.status, configurations,
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
