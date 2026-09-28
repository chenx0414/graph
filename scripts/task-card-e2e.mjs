// Real end-to-end proof of the end-of-task card: a real daemon, a real store with a finished
// task, the real built console in a real browser, reading the card out of the DOM.
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { TaskStore } from '../src/core/store.ts';
import { startGraphDaemon } from '../src/server/start.ts';

const root = await mkdtemp(join(tmpdir(), 'task-card-e2e-'));
const stateDir = join(root, 'state');
await mkdir(stateDir, { recursive: true });
const store = new TaskStore(join(stateDir, 'tasks.sqlite'));

// A conversation with one delivered task and one still running: the card must appear for
// exactly one of them, which also proves a running task is not reported as finished.
store.transaction(() => {
  store.db.prepare('INSERT INTO projects(id,root,grants) VALUES(?,?,?)').run('p', root, '[]');
  store.db.prepare("INSERT INTO tasks(id,project_id,request,created_seq,phase,conversation_id) VALUES('anchor','p','chat',1,'chatting','c')").run();
  store.db.prepare("INSERT INTO conversations(id,workspace_project_id,anchor_task_id,title,created_seq,created_at) VALUES('c','p','anchor','端到端卡片验证',1,1)").run();
  store.db.prepare("INSERT INTO nodes(task_id,id,spec,activation_id,status) VALUES('anchor','master','{\"role\":\"master\"}','a','idle')").run();
  store.db.prepare("INSERT INTO tasks(id,project_id,request,requirement_version,latest_proposal,accepted_proposal,target_branch,phase,created_seq,graph_version,integration_sha,conversation_id) VALUES('done','p','实现卡片功能',11,1,1,'main','completed',2,1,'deadbeefcafe1234','c')").run();
  store.db.prepare("INSERT INTO nodes(task_id,id,spec,activation_id,status) VALUES('done','build','{\"kind\":\"agent\"}','a1','succeeded')").run();
  store.db.prepare("INSERT INTO nodes(task_id,id,spec,activation_id,status) VALUES('done','check','{\"kind\":\"program\"}','a2','succeeded')").run();
  store.db.prepare("INSERT INTO operations(id,task_id,node_id,generation,spec,state,reserved,worker_active,waiting_slot) VALUES('op1','done','build',1,'{}','settled',0,0,0)").run();
  store.db.prepare("INSERT INTO invocations(id,operation_id,instance_id,model,usage,cost,purpose) VALUES('i1','op1','inst','m','{\"input\":100,\"output\":20,\"cacheRead\":0,\"cacheWrite\":0}','{\"amount\":0.42,\"currency\":\"USD\"}','completion')").run();
  // Node usage is what the card reads for tokens, exactly as the console reports it.
  store.db.prepare("INSERT INTO instances(id,task_id,node_id,definition_version,model,used,budget,unlimited) VALUES('i-build','done','build','coder@1','m',7000,0,1)").run();
  store.db.prepare("UPDATE nodes SET instance_id='i-build' WHERE task_id='done' AND id='build'").run();
  store.db.prepare("INSERT INTO instances(id,task_id,node_id,definition_version,model,used,budget,unlimited) VALUES('i-check','done','check','coder@1','m',1200,0,1)").run();
  store.db.prepare("UPDATE nodes SET instance_id='i-check' WHERE task_id='done' AND id='check'").run();
  store.db.prepare("INSERT INTO evidence(id,task_id,node_id,operation_id,acceptance_id,proposal_version,requirement_version,data,activation_id,valid,commit_sha) VALUES('e1','done','check','op1','card-shows',1,11,'{}','a2',1,'deadbeefcafe1234')").run();
  store.db.prepare("INSERT INTO tasks(id,project_id,request,latest_proposal,phase,created_seq,graph_version,conversation_id) VALUES('live','p','仍在跑的任务',1,'running',3,1,'c')").run();
  store.db.prepare("INSERT INTO nodes(task_id,id,spec,activation_id,status) VALUES('live','work','{\"kind\":\"agent\"}','a3','running')").run();
});

const daemon = await startGraphDaemon({
  stateDir,
  port: 0,
  webDir: new URL('../dist/web', import.meta.url).pathname,
  configPath: null,
  mode: 'view',
  env: process.env,
});
const port = new URL(daemon.url).port;
const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on('pageerror', error => errors.push(String(error)));
try {
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' });
  await page.waitForSelector('#root > *', { timeout: 20000 });
  console.log('shell mounted');
  await page.goto(`http://127.0.0.1:${port}/#/conversations/c`, { waitUntil: 'load' });
  await page.goto(`http://127.0.0.1:${port}/#/conversations/c`, { waitUntil: 'load' });
  try { await page.waitForSelector('[data-testid="task-end-card"]', { timeout: 15000 }); }
  catch { console.log('card missing; body text:', (await page.textContent('body'))?.slice(0, 600)); console.log('errors:', errors); throw new Error('card not rendered'); }
  const result = await page.evaluate(() => {
    const card = document.querySelector('[data-testid="task-end-card"]');
    const read = key => card?.querySelector(`[data-testid="${key}"]`)?.textContent ?? null;
    return {
      cards: document.querySelectorAll('[data-testid="task-end-card"]').length,
      outcome: card?.getAttribute('data-outcome'),
      outcomeText: read('task-end-outcome'),
      cost: read('task-end-cost'),
      tokens: read('task-end-tokens'),
      nodes: read('task-end-nodes'),
      delivery: read('task-end-delivery'),
      hasLiveCard: document.body.textContent?.includes('仍在跑的任务') && document.querySelectorAll('[data-testid="task-end-card"]').length > 1,
    };
  });
  console.log(JSON.stringify(result, null, 2));
  await page.screenshot({ path: '/tmp/occham-evidence/item3-task-end-card.png', fullPage: true });
  console.log('pageerrors', errors.length ? errors : 'none');
  const ok = result.cards === 1 && result.outcome === 'delivered' && result.outcomeText === '已交付'
    && result.cost === '0.42 USD' && result.tokens === '8,200' && result.delivery?.includes('deadbeefca')
    && result.hasLiveCard === false;
  console.log(ok ? 'PASS' : 'FAIL');
  process.exitCode = ok ? 0 : 1;
} finally {
  await browser.close();
  await daemon.close?.();
  await rm(root, { recursive: true, force: true });
}
