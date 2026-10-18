import { DatabaseSync } from 'node:sqlite';

// Explicit input avoids silently measuring a different installation. Never migrates the DB.
if (process.argv.length !== 3 || process.argv[2] === '--help') {
  console.error('Usage: node scripts/harness-cost.mjs /absolute/path/to/tasks.sqlite');
  process.exit(process.argv[2] === '--help' ? 0 : 1);
}
const db = new DatabaseSync(process.argv[2], { readOnly: true });
try {
  db.exec('BEGIN'); // One consistent snapshot even while Graph is running.
  const exists = name => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
  const rows = sql => db.prepare(sql).all();
  const parse = text => { try { return JSON.parse(text); } catch { return null; } };
  const billing = ['input', 'output', 'cacheRead', 'cacheWrite'];
  const profiles = exists('events') ? rows("SELECT task_id,data FROM events WHERE type='provider.request_profile'") : [];
  const profilesByCall = new Map(profiles.map(row => { const data = parse(row.data); return [data?.callId, data]; }));
  const billingCosts = {};
  const models = new Map();
  let callsWithFrozenRates = 0;
  const tasks = new Map(rows('SELECT id,phase FROM tasks').map(row => [row.id, {
    id: row.id, phase: row.phase, requests: 0, unknownUsage: 0, estimatedUsage: 0, cacheHitRequests: 0, measuredRequests: 0,
    cacheMeasuredRequests: 0, cacheEvidenceTokens: { input: 0, cacheRead: 0, cacheWrite: 0 },
    tokens: Object.fromEntries(billing.map(key => [key, 0])), costs: {}, unknownCost: 0,
    operations: new Set(), executions: new Set(), purposes: {},
  }]));
  const calls = [
    ...(exists('invocations') ? rows(`SELECT i.id,o.task_id,i.usage,i.cost,i.purpose,i.operation_id AS turn,'main' AS lane
      FROM invocations i JOIN operations o ON o.id=i.operation_id`) : []),
    ...(exists('kernel_provider_calls') ? rows(`SELECT id,task_id,usage,cost,purpose,execution_id AS turn,model AS frozen_model,'node' AS lane FROM kernel_provider_calls`) : []),
  ];
  for (const call of calls) {
    const task = tasks.get(call.task_id);
    if (!task) continue;
    const usage = parse(call.usage);
    // Tool admission also uses the invocation ledger; zero-token tool calls are not model turns.
    // Retain missing usage: it may be a billed request and cannot be treated as zero.
    if (usage && billing.every(key => usage[key] === 0) && call.lane === 'main' && !profilesByCall.has(call.id)) continue;
    const frozen = parse(call.frozen_model);
    const profile = profilesByCall.get(call.id);
    const identity = profile?.model ?? (frozen?.provider && frozen?.id ? `${frozen.provider}:${frozen.id}` : null);
    const model = models.get(identity) ?? {model:identity,requests:0,unknownUsage:0,estimatedUsage:0,tokens:Object.fromEntries(billing.map(key=>[key,0]))};
    models.set(identity,model);model.requests++;
    const validUsage = usage && billing.every(key=>Number.isFinite(usage[key]) && usage[key]>=0);
    if(!validUsage || usage.usageSource==='unknown')model.unknownUsage++;
    if(validUsage){
      if(usage.usageSource==='estimated')model.estimatedUsage++;
      for(const key of billing)model.tokens[key]+=usage[key];
    }
    task.requests++;
    task.purposes[call.purpose] = (task.purposes[call.purpose] ?? 0) + 1;
    task[call.lane === 'main' ? 'operations' : 'executions'].add(call.turn);
    if (!usage || billing.some(key => !Number.isFinite(usage[key]) || usage[key] < 0)) task.unknownUsage++;
    else {
      if (usage.usageSource === 'estimated') task.estimatedUsage++;
      if (usage.usageSource === 'unknown') task.unknownUsage++;
      for (const key of billing) task.tokens[key] += usage[key];
      task.measuredRequests++;
      const cacheEvidence = usage.usageSource === undefined || usage.usageSource === 'authoritative' || usage.usageSource === 'account_delta';
      if (cacheEvidence && usage.input + usage.cacheRead + usage.cacheWrite > 0) {
        task.cacheMeasuredRequests++;
        if (usage.cacheRead > 0) task.cacheHitRequests++;
        for (const key of ['input', 'cacheRead', 'cacheWrite']) task.cacheEvidenceTokens[key] += usage[key];
      }
      const rates = frozen?.cost ?? profile?.rates;
      const pricing = frozen?.pricing ?? profile?.pricing;
      if (cacheEvidence && rates && billing.every(key => Number.isFinite(rates[key]) && rates[key] >= 0)) {
        callsWithFrozenRates++;
        const totals = billingCosts[pricing?.currency ?? 'unspecified'] ??= Object.fromEntries(billing.map(key => [key, 0]));
        for (const key of billing) totals[key] += usage[key] * rates[key] / 1_000_000;
      }
    }
    const cost = parse(call.cost);
    if (typeof cost?.amount === 'number' && Number.isFinite(cost.amount)) {
      const currency = cost.currency ?? 'unspecified';
      task.costs[currency] = (task.costs[currency] ?? 0) + cost.amount;
    } else task.unknownCost++;
  }
  const sources = {};
  const toolResults = new Map();
  let toolResultProfileSamples = 0;
  const fingerprints = new Set();
  for (const row of profiles) {
    const profile = parse(row.data);
    if (!profile?.sections) continue;
    if (Array.isArray(profile.toolResults)) {
      toolResultProfileSamples++;
      for (const result of profile.toolResults) {
        const row = toolResults.get(result.tool) ?? {tool:result.tool,requestViews:0,resultViews:0,bytes:0,estimatedTokens:0};
        row.requestViews++;
        for (const key of ['resultViews','bytes','estimatedTokens']) row[key]+=result[key];
        toolResults.set(result.tool,row);
      }
    }
    fingerprints.add(profile.staticFingerprint);
    for (const [source, section] of Object.entries(profile.sections)) {
      const value = sources[source] ??= { bytes: 0, estimatedTokens: 0 };
      value.bytes += section.bytes;
      value.estimatedTokens += section.estimatedTokens;
    }
  }
  const observedTasks = [...tasks.values()].filter(task => task.requests > 0);
  const toolRows = exists('tool_calls') ? rows(`SELECT tool,COUNT(*) AS calls,SUM(is_error) AS errors,
    COUNT(DISTINCT task_id) AS tasks FROM tool_calls GROUP BY tool ORDER BY calls DESC`) : [];
  const toolDenominator = exists('tool_calls') ? rows('SELECT COUNT(DISTINCT task_id) AS n FROM tool_calls')[0].n : 0;
  const outputTasks = observedTasks.map(task => ({ ...task,
    operations: task.operations.size, executions: task.executions.size,
    cacheUnmeasuredRequests: task.requests - task.cacheMeasuredRequests,
    cacheHitRequestRate: task.cacheMeasuredRequests ? task.cacheHitRequests / task.cacheMeasuredRequests : null,
    cacheReadFraction: task.cacheEvidenceTokens.input + task.cacheEvidenceTokens.cacheRead + task.cacheEvidenceTokens.cacheWrite > 0
      ? task.cacheEvidenceTokens.cacheRead / (task.cacheEvidenceTokens.input + task.cacheEvidenceTokens.cacheRead + task.cacheEvidenceTokens.cacheWrite) : null,
  }));
  const completed = outputTasks.filter(task => task.phase === 'completed');
  const completedCosts = {};
  for (const task of completed) for (const [currency, amount] of Object.entries(task.costs)) {
    completedCosts[currency] = (completedCosts[currency] ?? 0) + amount;
  }
  console.log(JSON.stringify({
    schemaVersion: 1,
    caveats: [
      'Known costs are lower bounds when unknownCost > 0; unspecified currency is never combined with named currencies.',
      'operations/executions are task-level turns; requests include retries, compaction and optional model calls.',
      'Source estimates describe rendered JSON, not provider tokenizer counts or source-by-billing cost attribution.',
      'Per-tool result views count repeated appearances in provider requests, not tool executions; null tool identities and historical profiles without this field are not attributed.',
      'File/search/command/summary provenance is unavailable in historical wire messages; no fabricated source split.',
      'Main conversations and child graphs remain separate task rows; completion costs exclude unallocated main planning.',
      'Tool reach uses tasks with retained tool telemetry; retention can differ from invocation retention.',
      'Tool rows reflect SQLite only; worker spools must first be ingested through the public tool statistics read. Empty rows do not establish zero tool use.',
      'Cache metrics and costByBillingType exclude estimated/unknown provenance; local estimates cannot establish cache misses.',
    ],
    summary: {
      tasks: outputTasks.length, completedTasks: completed.length,
      completedKnownCosts: completedCosts,
      costByBillingType: { callsWithFrozenRates, amounts: billingCosts },
      costPerCompletedTask: completed.length && completed.every(task => !task.unknownCost && !task.unknownUsage && !task.estimatedUsage)
        ? Object.fromEntries(Object.entries(completedCosts).map(([currency, amount]) => [currency, amount / completed.length])) : null,
      requests: outputTasks.reduce((sum, task) => sum + task.requests, 0),
      unknownCost: outputTasks.reduce((sum, task) => sum + task.unknownCost, 0),
      tokens: Object.fromEntries(billing.map(key => [key, outputTasks.reduce((sum, task) => sum + task.tokens[key], 0)])),
    },
    requestProfiles: { samples: profiles.length, distinctStaticFingerprints: fingerprints.size, sources,
      toolResultProfileSamples,toolResultUnprofiledSamples:profiles.length-toolResultProfileSamples,toolResults:[...toolResults.values()].sort((a,b)=>b.bytes-a.bytes),
      meanEstimatedStaticTokens: profiles.length ? ((sources.system?.estimatedTokens ?? 0) + (sources.tools?.estimatedTokens ?? 0)) / profiles.length : null },
    tools: toolRows.map(tool => ({ ...tool, errorRate: tool.errors / tool.calls, taskReach: toolDenominator ? tool.tasks / toolDenominator : null })),
    models: [...models.values()],
    tasks: outputTasks,
  }, null, 2));
  db.exec('COMMIT');
} finally { db.close(); }
