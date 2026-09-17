import { estimateCost, type ModelEntry } from '../catalog/models.ts';
import { addInstanceUsage } from './context.ts';
import { canonicalJson, type TaskStore } from './store.ts';
import { RuntimeError, type TokenUsage } from './types.ts';

export interface InterruptedOperationRow {
  id: string;
  task_id: string;
  instance_id: string | null;
  result: string | null;
  worker_active: number;
}

/** Release one interrupted operation's unknown usage after user reconciliation. */
export function recordInterruptedUsage(
  store: TaskStore,
  operation: InterruptedOperationRow,
  answer: { type: 'usage'; usage: TokenUsage; proof: string } | { type: 'reconcile_usage'; proof: string },
  models?: () => ModelEntry[],
) {
  if (!answer.proof.trim()) throw new RuntimeError('invalid_answer', 'Evidence is required to release unknown usage');
  if (operation.result || operation.worker_active) {
    throw new RuntimeError('invalid_answer', 'Interrupted usage reconciliation requires a quiescent operation without a result');
  }
  if (answer.type === 'usage') {
    const unknown = store.db.prepare('SELECT id FROM invocations WHERE operation_id=? AND usage IS NULL')
      .all(operation.id) as { id: string }[];
    if (unknown.length !== 1) {
      throw new RuntimeError('invalid_answer', 'Recording authoritative usage requires exactly one unknown invocation');
    }
    const values = [answer.usage.input, answer.usage.output, answer.usage.cacheRead, answer.usage.cacheWrite];
    const total = values.reduce((sum, value) => sum + value, 0);
    if (values.some(value => !Number.isSafeInteger(value) || value < 0) || !Number.isSafeInteger(total)) {
      throw new RuntimeError('invalid_usage', 'Invalid disjoint token counts');
    }
    const instance = operation.instance_id
      ? store.db.prepare('SELECT model FROM instances WHERE id=?').get(operation.instance_id) as { model: string | null }
      : undefined;
    const entry = instance?.model ? models?.().find(model => model.id === instance.model) : undefined;
    store.db.prepare('UPDATE invocations SET usage=?,cost=? WHERE id=?')
      .run(canonicalJson(answer.usage), canonicalJson(estimateCost(answer.usage, entry?.cost, entry?.pricing)), unknown[0]!.id);
  }
  const known = (store.db.prepare('SELECT usage FROM invocations WHERE operation_id=? AND usage IS NOT NULL')
    .all(operation.id) as { usage: string }[])
    .reduce<TokenUsage>((sum, row) => {
      const usage = JSON.parse(row.usage) as TokenUsage;
      return {
        input: sum.input + usage.input,
        output: sum.output + usage.output,
        cacheRead: sum.cacheRead + usage.cacheRead,
        cacheWrite: sum.cacheWrite + usage.cacheWrite,
      };
    }, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  const total = known.input + known.output + known.cacheRead + known.cacheWrite;
  if (total > 0 && operation.instance_id) {
    addInstanceUsage(store, operation.instance_id, total);
    const account = store.db.prepare('SELECT model,models_used FROM instances WHERE id=?')
      .get(operation.instance_id) as { model: string | null; models_used: string };
    const usedModels = JSON.parse(account.models_used) as string[];
    if (account.model && !usedModels.includes(account.model)) {
      store.db.prepare('UPDATE instances SET models_used=? WHERE id=?')
        .run(canonicalJson([...usedModels, account.model]), operation.instance_id);
    }
  }
  store.event(operation.task_id, 'operation.usage_reconciled', {
    operationId: operation.id,
    decision: answer.type === 'usage' ? 'recorded' : 'usage_unavailable',
    known,
    proof: answer.proof,
  });
}
