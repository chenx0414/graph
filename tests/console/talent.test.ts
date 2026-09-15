import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, test } from 'vitest';
import { TaskStore, canonicalJson } from '../../src/core/store.ts';
import { talentDetail, talentExperience } from '../../src/core/talent.ts';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const action of cleanup.reverse()) await action(); cleanup.length = 0; });

async function store() {
  const root = await mkdtemp(join(tmpdir(), 'graph-talent-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const db = new TaskStore(join(root, 'tasks.sqlite'));
  cleanup.push(async () => db.close());
  db.transaction(() => {
    db.db.prepare('INSERT INTO projects(id,root,grants) VALUES(?,?,?)').run('p', root, '[]');
  });
  return db;
}

let sequence = 0;
function addSample(db: TaskStore, input: {
  definition: string; version: number; model?: string; status?: string; role?: string;
  tokenUsage?: number | null; runMs?: number | null; attempts?: number; cost?: { amount: number; currency: string } | null | 'unknown';
}) {
  sequence += 1;
  const taskId = `task-${sequence}`;
  const nodeId = 'work';
  const instanceId = `inst-${sequence}`;
  const status = input.status ?? 'succeeded';
  const attempts = input.attempts ?? 1;
  db.transaction(() => {
    db.db.prepare('INSERT INTO tasks(id,project_id,request,created_seq) VALUES(?,?,?,?)').run(taskId, 'p', `sample ${sequence}`, sequence);
    const spec = input.role ? { id: nodeId, kind: 'agent', action: 'work', role: input.role } : { id: nodeId, kind: 'agent', action: 'work' };
    db.db.prepare('INSERT INTO nodes(task_id,id,spec,instance_id,status,activation_id,output_version,stall_count) VALUES(?,?,?,?,?,?,0,0)')
      .run(taskId, nodeId, canonicalJson(spec), instanceId, status, `act-${sequence}`);
    db.db.prepare('INSERT INTO instances(id,task_id,node_id,definition_version,model,budget,used,unlimited,models_used) VALUES(?,?,?,?,?,?,0,1,?)')
      .run(instanceId, taskId, nodeId, `${input.definition}@${input.version}`, input.model ?? 'm1', 0, canonicalJson([]));
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const opId = randomUUID();
      const dispatched = input.runMs === null || input.runMs === undefined ? null : 1_000 + attempt * 1_000_000;
      const settled = dispatched === null ? null : dispatched + (input.runMs ?? 0);
      db.db.prepare(`INSERT INTO operations(id,task_id,node_id,instance_id,generation,spec,state,reserved,worker_active,result,usage,activation_id,dispatched_at,settled_at,waiting_ms)
        VALUES(?,?,?,?,0,'{}','succeeded',0,0,'{}',NULL,?,?,?,0)`)
        .run(opId, taskId, nodeId, instanceId, `act-${sequence}`, dispatched, settled);
      if (input.tokenUsage !== undefined) {
        const known = input.tokenUsage !== null;
        const usage = known ? { input: input.tokenUsage!, output: 0, cacheRead: 0, cacheWrite: 0 } : null;
        let cost: unknown = null;
        if (known) {
          if (input.cost === 'unknown' || input.cost === undefined) cost = { unknown: true };
          else if (input.cost !== null) cost = { amount: input.cost.amount, currency: input.cost.currency, unit: 'per_million_tokens', priceRevision: 'r1' };
        }
        db.db.prepare('INSERT INTO invocations(id,operation_id,instance_id,model,usage,cost) VALUES(?,?,?,?,?,?)')
          .run(randomUUID(), opId, instanceId, input.model ?? 'm1', usage ? canonicalJson(usage) : null, cost === null ? null : canonicalJson(cost));
      }
    }
  });
  return { taskId, nodeId, instanceId };
}

test('experience uses complete samples per metric and never disguises unknown as zero', async () => {
  const db = await store();
  db.transaction(() => {
    db.db.prepare("INSERT INTO definitions(id,version,spec) VALUES('coder',1,'{}')").run();
    db.db.prepare("INSERT INTO definitions(id,version,spec) VALUES('coder',2,'{}')").run();
  });
  addSample(db, { definition: 'coder', version: 2, tokenUsage: 100, runMs: 10_000, cost: { amount: 0.1, currency: 'USD' } });
  addSample(db, { definition: 'coder', version: 2, tokenUsage: 300, runMs: 30_000, cost: { amount: 0.2, currency: 'USD' } });
  addSample(db, { definition: 'coder', version: 2, tokenUsage: null, runMs: null, cost: 'unknown' });
  const stats = talentExperience(db, 'coder').task;
  expect(stats.token).toMatchObject({ mean: 200, samples: 2, unknown: 1 });
  expect(stats.runMs).toMatchObject({ mean: 20_000, samples: 2, unknown: 1 });
  expect(stats.cost.mixedCurrency).toBe(false);
  // The currency-less unknown sample is reported at the summary level; the
  // USD bucket only contains attributed samples.
  expect(stats.cost.unknown).toBe(true);
  expect(stats.cost.byCurrency).toEqual([expect.objectContaining({ currency: 'USD', samples: 2, unknown: 0, mean: expect.closeTo(0.15, 10) })]);
  expect(stats.totalSamples).toBe(3);
}, 30_000);

test('cross-missing metrics keep their own denominators and cross-version pools raw sums', async () => {
  const db = await store();
  db.transaction(() => {
    db.db.prepare("INSERT INTO definitions(id,version,spec) VALUES('coder',1,'{}')").run();
    db.db.prepare("INSERT INTO definitions(id,version,spec) VALUES('coder',2,'{}')").run();
  });
  // token known, price unknown, time known
  addSample(db, { definition: 'coder', version: 1, tokenUsage: 100, runMs: 10_000, cost: 'unknown' });
  // token unknown, price unknown, time known
  addSample(db, { definition: 'coder', version: 2, tokenUsage: null, runMs: 30_000, cost: 'unknown' });
  const all = talentExperience(db, 'coder', { allVersions: true }).all;
  expect(all.token).toMatchObject({ mean: 100, samples: 1, unknown: 1 });
  expect(all.runMs).toMatchObject({ mean: 20_000, samples: 2, unknown: 0 });
  expect(all.cost.byCurrency).toEqual([]);
  expect(all.cost.unknown).toBe(true);
  // Per-version view only includes that version.
  const v1 = talentExperience(db, 'coder', { version: 1 }).task;
  expect(v1.totalSamples).toBe(1);
  expect(v1.runMs.mean).toBe(10_000);
}, 30_000);

test('the default experience scope matches the detail version and all-versions is explicit', async () => {
  const db = await store();
  db.transaction(() => {
    db.db.prepare("INSERT INTO definitions(id,version,spec) VALUES('coder',1,'{}')").run();
    db.db.prepare("INSERT INTO definitions(id,version,spec) VALUES('coder',2,'{}')").run();
  });
  addSample(db, { definition: 'coder', version: 1, tokenUsage: 100, runMs: 1_000 });
  addSample(db, { definition: 'coder', version: 2, tokenUsage: 900, runMs: 9_000 });
  const scoped = talentExperience(db, 'coder');
  expect(scoped.scope).toEqual({ version: 2, allVersions: false });
  expect(scoped.task.token).toMatchObject({ mean: 900, samples: 1 });
  const all = talentExperience(db, 'coder', { allVersions: true });
  expect(all.scope).toEqual({ version: null, allVersions: true });
  expect(all.task.token).toMatchObject({ mean: 500, samples: 2 });
  const explicit = talentExperience(db, 'coder', { version: 1 });
  expect(explicit.task.token.mean).toBe(100);
  const detail = talentDetail(db, 'coder');
  expect(detail.version).toBe(2);
}, 30_000);

test('multi-currency experience keeps per-currency means and no mixed number', async () => {
  const db = await store();
  db.transaction(() => {
    db.db.prepare("INSERT INTO definitions(id,version,spec) VALUES('coder',1,'{}')").run();
  });
  addSample(db, { definition: 'coder', version: 1, tokenUsage: 100, runMs: 1_000, cost: { amount: 10, currency: 'USD' } });
  addSample(db, { definition: 'coder', version: 1, tokenUsage: 100, runMs: 1_000, cost: { amount: 10, currency: 'CNY' } });
  const stats = talentExperience(db, 'coder').task;
  expect(stats.cost.mixedCurrency).toBe(true);
  expect(stats.cost.byCurrency).toEqual([
    expect.objectContaining({ currency: 'CNY', mean: 10, samples: 1 }),
    expect.objectContaining({ currency: 'USD', mean: 10, samples: 1 }),
  ]);
}, 30_000);

test('rework counts once per instance and master chat is a separate series', async () => {
  const db = await store();
  db.transaction(() => {
    db.db.prepare("INSERT INTO definitions(id,version,spec) VALUES('coder',1,'{}')").run();
  });
  addSample(db, { definition: 'coder', version: 1, tokenUsage: 100, runMs: 1_000, attempts: 3 });
  addSample(db, { definition: 'coder', version: 1, tokenUsage: 50, runMs: 500, role: 'master' });
  const experience = talentExperience(db, 'coder');
  expect(experience.task.totalSamples).toBe(1);
  expect(experience.chat.totalSamples).toBe(1);
  expect(experience.samples[0]).toMatchObject({ kind: 'task', attempts: 3, reworkRounds: 2 });
  expect(experience.samples[1]!.kind).toBe('chat');
  // Means are per series, not mixed across chat and tasks.
  // Rework continues the same instance, so its three calls accumulate.
  expect(experience.task.token.mean).toBe(300);
  expect(experience.chat.token.mean).toBe(50);
}, 30_000);

test('an unfinished sample is excluded from means and reported as unfinished', async () => {
  const db = await store();
  db.transaction(() => {
    db.db.prepare("INSERT INTO definitions(id,version,spec) VALUES('coder',1,'{}')").run();
  });
  addSample(db, { definition: 'coder', version: 1, tokenUsage: 100, runMs: 10_000, cost: { amount: 0.1, currency: 'USD' } });
  addSample(db, { definition: 'coder', version: 1, tokenUsage: 9_999, runMs: 99_000, status: 'pending' });
  const stats = talentExperience(db, 'coder').task;
  expect(stats.token).toMatchObject({ mean: 100, samples: 1, unfinished: 1 });
  expect(stats.runMs).toMatchObject({ mean: 10_000, samples: 1, unfinished: 1 });
  expect(talentExperience(db, 'nobody').all.totalSamples).toBe(0);
}, 30_000);

test('talent detail exposes versions, bound capability state and traceability', async () => {
  const db = await store();
  db.transaction(() => {
    db.db.prepare("INSERT INTO definitions(id,version,spec) VALUES('coder',1,?)")
      .run(canonicalJson({ recommendedGrade: 'medium', capabilities: [{ id: 'skill-x', version: '1.0.0' }], snapshot: { preset: { id: 'agent-coder', version: '1.0.0', hash: 'abcd' }, description: '内置实现人才' } }));
    db.db.prepare("INSERT INTO capabilities(id,kind,source,version,snapshot,status) VALUES('skill-x','skill','/presets/x','1.0.0','{}','installed')").run();
  });
  const detail = talentDetail(db, 'coder');
  expect(detail).toMatchObject({ id: 'coder', version: 1, recommendedGrade: 'medium', description: '内置实现人才' });
  expect(detail.traceability).toMatchObject({ origin: 'preset', id: 'agent-coder' });
  expect(detail.capabilities).toEqual([{ id: 'skill-x', version: '1.0.0', kind: 'skill', status: 'installed', source: '/presets/x' }]);
  expect(() => talentDetail(db, 'missing')).toThrowError(/Unknown Agent definition/);
}, 30_000);
