import type { ArtifactWorkspace } from './artifact-workspace.ts';
import type { KernelStore } from './kernel-store.ts';
import type { AcceptanceCriterion } from './interface-spec.ts';
import { canonicalJson } from './store.ts';
import type { NativeProposal } from './types.ts';

export interface AcceptanceStatus {
  id: string;
  description: string;
  kind: string;
  status: 'passed' | 'missing' | 'failed' | 'stale';
  reason: string;
  source?: { id: string; version?: number; commit?: string | null };
}
export interface GraphAcceptance {
  ready: boolean;
  drained: boolean;
  commit: string | null;
  items: AcceptanceStatus[];
  human: AcceptanceCriterion[];
  delivery: { required: boolean; commit: string | null };
}

const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));

/** Read a bounded immutable report and verify the published bytes, not mutable metadata. */
function report(artifacts: ArtifactWorkspace | undefined, graphId: string, artifactId: string, version: number): Record<string, unknown> | null {
  try { const value: unknown = JSON.parse(artifacts!.readVerifiedContent(graphId, artifactId, version).toString('utf8')); return object(value) ? value : null; }
  catch { return null; }
}

/** Final acceptance consumes authoritative operation, publication and actual-send records. */
export function graphAcceptance(kernel: KernelStore, graphId: string, artifacts?: ArtifactWorkspace): GraphAcceptance {
  const task = kernel.store.task(graphId);
  const definition = kernel.latestRevision(graphId)!.definition;
  const criteria = definition.acceptance ?? [];
  const commit = task.integration_sha ?? null;
  const items: AcceptanceStatus[] = [];
  const human: AcceptanceCriterion[] = [];
  const fail = (id: string, reason: string) => items.push({ id, description: reason, kind: 'constraint', status: 'missing', reason });
  if (task.integration_branch && !criteria.some(item => item.kind === 'check')) fail('host-check', 'Git delivery requires declared host checks');
  if (task.integration_branch && !commit) fail('integration-version', 'Current integration commit is unavailable');
  const changed = Boolean(task.integration_branch && commit !== task.target_sha);
  if (changed && !criteria.some(item => item.kind === 'review')) fail('independent-review', 'Code changes require declared independent review');
  if (task.accepted_proposal) {
    const row = kernel.db.prepare('SELECT spec FROM proposals WHERE task_id=? AND version=?').get(graphId, task.accepted_proposal) as { spec: string } | undefined;
    if (!row) fail('confirmed-acceptance', 'Confirmed requirements are unavailable');
    else {
      const confirmed = JSON.parse(row.spec) as NativeProposal;
      if (confirmed.requirementVersion !== task.requirement_version) fail('requirement-version', 'Confirmed requirements no longer match this task version');
      for (const required of confirmed.acceptance) {
        const declared = criteria.find(item => item.id === required.id);
        const original = confirmed.definition?.acceptance?.find(item => item.id === required.id);
        const preserved = original ? declared && canonicalJson(declared) === canonicalJson(original)
          : declared && declared.description === required.description && (definition.modules[required.checkNode]?.type === 'operation'
            ? declared.kind === 'check' && declared.module === required.checkNode
            : declared.kind === 'review' && declared.node === required.checkNode);
        if (!preserved) fail(required.id, 'Confirmed acceptance must be preserved in the graph definition');
      }
    }
  }
  const calls = kernel.providerCalls(graphId);
  for (const criterion of criteria) {
    const result: AcceptanceStatus = { id: criterion.id, description: criterion.description, kind: criterion.kind,
      status: 'missing', reason: 'No valid evidence' };
    if (criterion.kind === 'check') {
      const row = kernel.db.prepare('SELECT id,state,request,result FROM kernel_module_operations WHERE task_id=? AND module_id=? ORDER BY rowid DESC LIMIT 1')
        .get(graphId, criterion.module) as { id: string; state: string; request: string; result: string | null } | undefined;
      if (row) {
        result.source = { id: row.id };
        if (row.state !== 'settled' || !row.result) result.reason = `Host check is ${row.state}`;
        else {
          const evaluated = kernel.content.decode<{ outputs: Record<string, Record<string, unknown>> }>(row.result);
          const operation = definition.modules[criterion.module]!.operation!;
          const output = evaluated.outputs[operation.output];
          const recorded = kernel.content.decode<{ operation: unknown }>(row.request);
          if (canonicalJson(recorded.operation) !== canonicalJson(operation)) { result.status = 'stale'; result.reason = 'Host check used another operation configuration'; }
          else if (output?.passed !== true) { result.status = 'failed'; result.reason = 'Host check did not pass'; }
          else if (commit && output.verifiedCommit !== commit) { result.status = 'stale'; result.reason = 'Host check does not verify the current clean commit'; }
          else { result.status = 'passed'; result.reason = 'Host check passed'; result.source.commit = commit; }
        }
      }
    } else if (criterion.kind === 'review') {
      const row = kernel.db.prepare(`SELECT a.artifact_id,a.version,a.producer_operation_id
        FROM artifacts a JOIN kernel_executions x ON x.id=a.producer_operation_id AND x.task_id=a.task_id AND x.node_id=a.producer_node_id
        WHERE a.task_id=? AND a.scope='task' AND a.state='published' AND a.producer_node_id=? AND x.state='completed'
          AND a.schema_kind='graph.review' AND a.schema_version=1 ORDER BY a.created_at DESC,a.rowid DESC LIMIT 1`)
        .get(graphId, criterion.node) as { artifact_id: string; version: number; producer_operation_id: string } | undefined;
      if (row) {
        result.source = { id: row.artifact_id, version: row.version };
        const value = report(artifacts, graphId, row.artifact_id, row.version);
        const execution = kernel.execution(row.producer_operation_id)!;
        const recipe = kernel.revision(graphId, execution.revisionVersion)?.definition.nodes[criterion.node]?.recipe;
        const reviewers = calls.filter(call => call.executionId === execution.id);
        const unknown = calls.some(call => !call.model?.recipe);
        const implementers = calls.filter(call => call.model?.recipe?.review === false);
        const independent = reviewers.length > 0 && reviewers.every(call => call.model?.recipe?.review === true
          && call.model.recipe.definition === recipe && ['settled', 'reconciled'].includes(call.state)
          && !implementers.some(work => work.model!.id === call.model!.id || work.model!.identity === call.model!.identity));
        if (!value || typeof value.passed !== 'boolean' || typeof value.reason !== 'string' || !value.reason.trim()) result.reason = 'Published review bytes are invalid';
        else if (value.commit !== commit) { result.status = 'stale'; result.reason = 'Review concerns another commit'; }
        else if (value.passed !== true) { result.status = 'failed'; result.reason = value.reason; }
        else if (unknown || !independent) result.reason = 'Actual reviewer model and independent recipe history are not proven';
        else { result.status = 'passed'; result.reason = value.reason; result.source.commit = commit; }
      }
    } else {
      const rows = kernel.db.prepare("SELECT id,data,answer FROM questions WHERE task_id=? AND kind='human_check' AND status='resolved' ORDER BY rowid DESC")
        .all(graphId) as { id: string; data: string; answer: string | null }[];
      const latest = rows.find(row => { const data = JSON.parse(row.data) as { acceptanceId?: string; commitSha?: string | null };
        return data.acceptanceId === criterion.id && data.commitSha === commit; });
      if (latest?.answer && (JSON.parse(latest.answer) as { type?: string }).type === 'acknowledge') { result.status = 'passed'; result.reason = 'User accepted this version'; result.source = { id: latest.id, commit }; }
      else { result.reason = 'User acceptance is required for this version'; human.push(criterion); }
    }
    items.push(result);
  }
  const pending = kernel.db.prepare(`SELECT 1 WHERE
    EXISTS(SELECT 1 FROM kernel_queue WHERE task_id=? AND state IN ('queued','claimed','failed')) OR
    EXISTS(SELECT 1 FROM kernel_executions WHERE task_id=? AND state='running') OR
    EXISTS(SELECT 1 FROM kernel_node_state WHERE task_id=? AND paused=1) OR
    EXISTS(SELECT 1 FROM kernel_module_inbox WHERE task_id=? AND processed=0) OR
    EXISTS(SELECT 1 FROM kernel_transition_outbox o JOIN kernel_module_transitions t ON t.id=o.transition_id WHERE t.task_id=? AND o.routed=0) OR
    EXISTS(SELECT 1 FROM questions WHERE task_id=? AND status='open') OR
    EXISTS(SELECT 1 FROM kernel_provider_calls WHERE task_id=? AND state IN ('inflight','unknown'))`)
    .get(graphId, graphId, graphId, graphId, graphId, graphId, graphId);
  const drained = !pending;
  const receipt = kernel.db.prepare('SELECT commit_sha FROM kernel_completion_delivery WHERE task_id=?').get(graphId) as { commit_sha: string } | undefined;
  return { ready: drained && !task.paused && items.every(item => item.status === 'passed'), drained, commit, items, human,
    delivery: { required: Boolean(task.integration_branch), commit: receipt?.commit_sha ?? null } };
}
