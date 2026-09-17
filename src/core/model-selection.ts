import type { Catalog } from '../catalog/catalog.ts';
import { selectModel, type ModelEntry } from '../catalog/models.ts';
import { modelsUsed } from './budget-ledger.ts';
import { loadGraph } from './graph.ts';
import type { TaskStore } from './store.ts';
import type { NodeSpec } from './types.ts';

export interface ExecutionNode {
  id: string;
  task_id: string;
}

export function isReviewer(spec: NodeSpec, catalog?: Catalog) {
  if (spec.context?.purpose === 'review' || spec.context?.purpose === 'verify') return true;
  if (!spec.definitionVersion || !catalog) return false;
  try { return catalog.definition(spec.definitionVersion).review === true; }
  catch { return false; }
}

export function implementerModels(store: TaskStore, spec: NodeSpec, node: ExecutionNode) {
  const graph = loadGraph(store, node.task_id);
  const models: string[] = [];
  const seen = new Set<string>();
  const walk = (id: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    if (graph.plan.containers.has(id)) {
      for (const leaf of graph.plan.leaves(id)) walk(leaf);
      return;
    }
    const target = graph.plan.nodes.get(id);
    if (!target) return;
    if (target.kind === 'agent') {
      // Union wire identity and the immutable model recorded at selection
      // time. A hot configuration change must not rewrite historical review
      // exclusion.
      const calls = store.db.prepare(`SELECT DISTINCT i.model AS model
        FROM invocations i JOIN operations o ON o.id=i.operation_id
        WHERE o.task_id=? AND o.node_id=? AND i.model IS NOT NULL`).all(node.task_id, id) as { model: string }[];
      models.push(...calls.map(call => call.model));
      const row = store.db.prepare('SELECT instance_id FROM nodes WHERE task_id=? AND id=?')
        .get(node.task_id, id) as { instance_id: string | null } | undefined;
      if (row?.instance_id) models.push(...modelsUsed(store, row.instance_id));
      return;
    }
    for (const dependency of graph.plan.dependencies.get(id) ?? []) walk(dependency);
  };
  for (const dependency of spec.dependsOn ?? []) walk(dependency);
  return [...new Set(models)];
}

export function pickModel(input: {
  store: TaskStore;
  spec: NodeSpec;
  node: ExecutionNode;
  models: () => ModelEntry[];
  catalog?: Catalog;
  preferences?: Partial<Record<ModelEntry['grade'], string[]>>;
}) {
  const directory = input.models();
  let definition: { recommendedGrade: ModelEntry['grade']; review?: boolean } = { recommendedGrade: 'medium' };
  if (input.spec.definitionVersion && input.catalog) {
    try { definition = input.catalog.definition(input.spec.definitionVersion); }
    catch { /* Unpublished keys still select by their requested model. */ }
  }
  const exclude = isReviewer(input.spec, input.catalog)
    ? implementerModels(input.store, input.spec, input.node)
    : [];
  return selectModel({
    ...(input.spec.model ? { requested: input.spec.model } : {}),
    grade: definition.recommendedGrade,
    directory,
    ...(input.preferences ? { preferences: input.preferences } : {}),
    ...(exclude.length ? { exclude } : {}),
  });
}

export function independentReviewReady(store: TaskStore, taskId: string, catalog?: Catalog) {
  const graph = loadGraph(store, taskId);
  const reviewers = [...graph.plan.nodes.values()].filter(spec => spec.kind === 'agent' && isReviewer(spec, catalog));
  if (!reviewers.length) return false;
  for (const spec of graph.plan.nodes.values()) {
    if (spec.action !== 'graph.verify' || !spec.verifier) continue;
    if (!spec.verifier.reportNodes.some(id => reviewers.some(reviewer => reviewer.id === id))) continue;
    if (graph.status(spec.id) !== 'succeeded') continue;
    const output = graph.output(spec.id);
    if (output && typeof output === 'object' && !Array.isArray(output)
      && output.kind === 'verification' && output.outcome === 'pass') return true;
  }
  return false;
}
