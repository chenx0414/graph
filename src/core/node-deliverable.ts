import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { KernelStore } from './kernel-store.ts';
import type { ArtifactWorkspace } from './artifact-workspace.ts';

/**
 * Keeping a v2 node's promise about a file (Issue #1 §13.8, HB-275).
 *
 * The old path let a node declare a `deliverable` and published it when the node settled.
 * That promise is what stops a node from "passing" without doing the work, so the v2
 * kernel keeps it: the declaration lives on the node in the definition (§5), and this
 * settles it when that node's execution completes.
 *
 * The contract is deliberately the old one, because every clause of it is load-bearing:
 *
 *   - the file is published as a task-scope artifact, so the node never has to remember
 *     a tool call to hand its work over;
 *   - a file that was never written, or that is empty, FAILS the node — a promise that is
 *     never kept is a failure, not a quiet pass;
 *   - identical bytes publish nothing new, because a new version would claim work that did
 *     not change.
 */

export interface SettleDeliverableInput {
  kernel: KernelStore;
  artifacts: ArtifactWorkspace;
  graphId: string;
  nodeId: string;
  /** The revision the execution ran at; the declaration is read from it. */
  revisionVersion: number;
  executionId: string;
  /** The node's workspace; the declared path is resolved inside it. */
  workspace: string;
}

export type SettleDeliverableOutcome =
  | { ok: true; published: boolean; artifactId?: string; version?: number }
  | { ok: false; reason: string };

export async function settleDeliverable(input: SettleDeliverableInput): Promise<SettleDeliverableOutcome> {
  const { kernel, graphId, nodeId, revisionVersion, executionId, workspace } = input;
  const revision = kernel.revision(graphId, revisionVersion);
  const deliverable = revision?.definition.nodes[nodeId]?.deliverable;
  // A node that promised nothing has nothing to keep.
  if (!deliverable) return { ok: true, published: false };
  const admitted = kernel.db.prepare('SELECT instance_id FROM kernel_nodes WHERE task_id=? AND node_id=?').get(graphId, nodeId) as { instance_id: string } | undefined;
  const instanceId = admitted?.instance_id ?? `${graphId}-${nodeId}`;

  const path = resolve(workspace, deliverable.path);
  const info = await stat(path).catch(() => undefined);
  if (!info?.isFile()) return { ok: false, reason: `${deliverable.path} was declared as this node's deliverable but was never written` };
  if (info.size === 0) return { ok: false, reason: `${deliverable.path} was declared as this node's deliverable but is empty` };

  const body = await readFile(path);
  const digest = createHash('sha256').update(body).digest('hex');
  const logicalKey = `${deliverable.namespace}/${deliverable.name}`;
  const head = input.artifacts.head(graphId, logicalKey);
  // The same bytes whoever wrote them: nothing changed, so a new version would say
  // something false about the work.
  if (head && head.digest === digest) return { ok: true, published: false, artifactId: head.artifactId, version: head.version };

  const record = await input.artifacts.publish({
    taskId: graphId,
    workspace,
    namespace: deliverable.namespace,
    name: deliverable.name,
    sourcePath: path,
    ...(deliverable.title ? { title: deliverable.title } : {}),
    ...(deliverable.summary ? { summary: deliverable.summary } : {}),
    // A v2 execution IS the operation (§3 replaces the operation model), so the kernel's
    // own identities stand in: the admitted instance, the execution, and the revision that
    // admitted it. The artifact therefore names exactly what produced it.
    producer: { nodeId, instanceId, operationId: executionId, activationId: `rev-${revisionVersion}` },
    requestId: `deliverable-${executionId}-${digest.slice(0, 12)}`,
  });
  return { ok: true, published: true, artifactId: record.artifactId, version: record.version };
}
