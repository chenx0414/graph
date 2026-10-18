import { readFile, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';

if (process.argv.length !== 3) throw new Error('Usage: node scripts/harness-eval-summary.mjs comparison.json');
const manifestPath = resolve(process.argv[2]);
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const billing = ['input', 'output', 'cacheRead', 'cacheWrite'];
const scopes = ['main-operation', 'worker-operation', 'workflow'];
const count = (value, name) => {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid ${name}`);
  return value;
};
const weights = manifest.weights;
const modelWeights = manifest.modelWeights;
if(weights && modelWeights)throw new Error('Choose uniform weights or modelWeights');
const modelRates=new Map();
if(modelWeights){
 if(typeof modelWeights.currency!=='string' || !modelWeights.currency || !Array.isArray(modelWeights.models) || !modelWeights.models.length)throw new Error('modelWeights requires a currency and model rates');
 for(const row of modelWeights.models){
  if(typeof row.model!=='string' || !row.model || modelRates.has(row.model) || billing.some(key=>row.perMillion?.[key]!==null && (!Number.isFinite(row.perMillion?.[key]) || row.perMillion[key]<0)))throw new Error('Each model needs a unique identity and four nonnegative or null rates');
  modelRates.set(row.model,row.perMillion);
 }
}
if (weights && (typeof weights.currency !== 'string' || !weights.currency || billing.some(key => !Number.isFinite(weights.perMillion?.[key]) || weights.perMillion[key] < 0))) {
  throw new Error('Weights require a currency and four nonnegative perMillion rates');
}
if (!Array.isArray(manifest.groups) || !manifest.groups.length) throw new Error('At least one group is required');
const seenRoots = new Set();
const names = new Set();
const groups = [];
for (const group of manifest.groups) {
  if (typeof group.name !== 'string' || !group.name || names.has(group.name)) throw new Error('Unique group names are required');
  names.add(group.name);
  if (!scopes.includes(group.scope) || !Array.isArray(group.runs) || !group.runs.length) throw new Error('Each group needs an explicit scope and runs');
  if (weights && group.scope === 'workflow') throw new Error('Uniform scenario weights cannot price a potentially mixed-model workflow');
  const total = { name: group.name, scope: group.scope, attempts: 0, completed: 0, requests: 0,
    unknownUsage: 0, estimatedUsage: 0, unknownCost: 0, tokens: Object.fromEntries(billing.map(key => [key, 0])) };
  const costs = new Map();
  let modelAmount=0,modelPricingComplete=true;
  const runs = [];
  for (const file of group.runs) {
    if (typeof file !== 'string') throw new Error('Run paths must be strings');
    const path = isAbsolute(file) ? file : resolve(dirname(manifestPath), file);
    const run = JSON.parse(await readFile(path, 'utf8'));
    if (typeof run.root !== 'string' || !isAbsolute(run.root)) throw new Error(`Missing absolute state root: ${path}`);
    const root = await realpath(run.root);
    if (seenRoots.has(root)) throw new Error(`Duplicate evaluation state root: ${root}`);
    seenRoots.add(root);
    const actualScope = run.workflow ? 'workflow' : run.execution ? 'worker-operation' : 'main-operation';
    if (actualScope !== group.scope) throw new Error(`Scope mismatch for ${path}: ${actualScope}`);
    const ledger = JSON.parse(await readFile(join(root, 'cost-report.json'), 'utf8'));
    if (ledger.schemaVersion !== 1 || !Array.isArray(ledger.tasks)) throw new Error(`Unsupported cost ledger: ${root}`);
    if(weights || modelWeights){
      if(!Array.isArray(ledger.models) || !ledger.models.length)throw new Error('Model breakdown required for scenario weights; regenerate cost-report.json');
      const modelTotals=Object.fromEntries(billing.map(key=>[key,0]));let modelRequests=0;
      for(const model of ledger.models){
        modelRequests+=count(model.requests,'model requests');
        for(const key of billing)modelTotals[key]+=count(model.tokens?.[key],`model ${key}`);
        if(weights && (ledger.models.length!==1 || typeof model.model!=='string'))throw new Error('Uniform scenario weights cannot price a mixed-model operation');
        if(modelWeights){
          const rates=modelRates.get(model.model);
          if(typeof model.model!=='string' || !rates)modelPricingComplete=false;
          for(const key of billing){
            const tokens=model.tokens[key],rate=rates?.[key];
            if(tokens>0){if(!Number.isFinite(rate) || rate<0)modelPricingComplete=false;else modelAmount+=tokens*rate/1_000_000;}
          }
        }
      }
      if(modelRequests!==ledger.summary.requests || billing.some(key=>modelTotals[key]!==ledger.summary.tokens[key]))throw new Error('Model breakdown differs from ledger totals');
    }
    // Success is the benchmark's external behavior + terminal-state result, not
    // a provider's completion message or the database's conversation phase.
    const complete = run.taskSuccess === true && !run.timedOut && !run.cleanupIncomplete
      && (actualScope !== 'workflow' || run.workflow.phase === 'completed');
    total.attempts++;
    total.completed += Number(complete);
    total.requests += count(ledger.summary.requests, 'requests');
    total.unknownCost += count(ledger.summary.unknownCost, 'unknownCost');
    for (const key of billing) total.tokens[key] += count(ledger.summary.tokens[key], key);
    for (const task of ledger.tasks) {
      total.unknownUsage += count(task.unknownUsage, 'unknownUsage');
      total.estimatedUsage += count(task.estimatedUsage ?? 0, 'estimatedUsage');
      for (const [currency, amount] of Object.entries(task.costs)) {
        if (!Number.isFinite(amount) || amount < 0) throw new Error('Invalid recorded cost');
        costs.set(currency, (costs.get(currency) ?? 0) + amount);
      }
    }
    runs.push({ path, root, model: run.model, caseId: run.caseId, complete });
  }
  const knownCost = Object.fromEntries(costs);
  const costPerCompletedTask = total.completed && !total.unknownCost && !total.unknownUsage && !total.estimatedUsage
    ? Object.fromEntries([...costs].map(([currency, amount]) => [currency, amount / total.completed])) : null;
  const scenarioAmount = weights ? billing.reduce((sum, key) => sum + total.tokens[key] * weights.perMillion[key] / 1_000_000, 0) : null;
  if (weights && !Number.isFinite(scenarioAmount)) throw new Error('Scenario cost overflow');
  groups.push({ ...total, successRate: total.completed / total.attempts, knownCost, costPerCompletedTask,
    ...(modelWeights ? {scenario:{currency:modelWeights.currency,models:modelWeights.models,pricingComplete:modelPricingComplete,
      usageComplete:!total.unknownUsage && !total.estimatedUsage,recordedTokenWeightTotal:modelPricingComplete?modelAmount:null,
      costPerCompletedTask:total.completed && modelPricingComplete && !total.unknownUsage && !total.estimatedUsage?modelAmount/total.completed:null}} : {}),
    ...(weights ? { scenario: { currency: weights.currency, perMillion: weights.perMillion, recordedTokenWeightTotal: scenarioAmount,
      usageComplete: !total.unknownUsage && !total.estimatedUsage,
      costPerCompletedTask: total.completed && !total.unknownUsage && !total.estimatedUsage ? scenarioAmount / total.completed : null } } : {}), runs });
}
console.log(JSON.stringify({ schemaVersion: 1, caveats: [
  'Every attempt contributes cost; failures are never removed from the numerator.',
  'Known cost is a subtotal when any usage or price is unknown; incomplete totals yield null cost per completed task.',
  'Token weights are an explicit scenario, not a reconstructed provider invoice; modelWeights uses recorded identities and retains missing rates as unknown.',
  'Scope is explicit: main or worker operations do not prove complete workflow savings.',
  'This summary provides no causal or statistical quality guarantee; inspect frozen tasks and validation evidence.',
], groups }, null, 2));
