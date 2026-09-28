// End-to-end: the console actually DRAWS a conditional branch (R23), through the real layout route
// and a real browser. This is the (a) half of the item: the mechanism was proven in the previous
// step, and this proves a person can see it.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { TaskStore, canonicalJson } from '../src/core/store.ts';
import { startGraphDaemon } from '../src/server/start.ts';

const root = await mkdtemp(join(tmpdir(), 'branch-edge-e2e-'));
const stateDir = join(root, 'state');
await mkdir(stateDir, { recursive: true });
const store = new TaskStore(join(stateDir, 'tasks.sqlite'));

// A real router graph: gate -> (pass) ship | (fail) fix, with the router resolving from a field.
const nodes = [
  { id: 'gate', kind: 'program', action: 'graph.command', routes: ['pass', 'fail'],
    input: { route: { byField: { path: 'verdict', values: { pass: 'pass', rework: 'fail' } } } } },
  { id: 'ship', kind: 'program', action: 'graph.command', dependsOn: ['gate'], when: { node: 'gate', case: 'pass' } },
  { id: 'fix', kind: 'program', action: 'graph.command', dependsOn: ['gate'], when: { node: 'gate', case: 'fail' } },
];
store.transaction(() => {
  store.db.prepare('INSERT INTO projects(id,root,grants) VALUES(?,?,?)').run('p', root, '[]');
  store.db.prepare("INSERT INTO conversations(id,workspace_project_id,anchor_task_id,title,created_seq,created_at) VALUES('c','p','t','分支可视化',1,1)").run();
  store.db.prepare("INSERT INTO tasks(id,project_id,request,latest_proposal,accepted_proposal,phase,created_seq,graph_version,conversation_id) VALUES('t','p','router graph',1,1,'running',1,1,'c')").run();
  for (const node of nodes) {
    store.db.prepare("INSERT INTO nodes(task_id,id,spec,status,activation_id) VALUES('t',?,?,'pending','a')")
      .run(node.id, canonicalJson(node));
  }
  // The revision the API reads: version 1, which the task's graph_version points at.
  store.db.prepare("INSERT INTO graph_revisions(task_id,version,spec,reason) VALUES('t',1,?,'e2e')")
    .run(canonicalJson({ nodes, containers: [], loops: [] }));
  // The router has already chosen `fail`, so one branch is active and the other is skipped.
  store.db.prepare("UPDATE nodes SET status='succeeded',route='fail' WHERE task_id='t' AND id='gate'").run();
});

const daemon = await startGraphDaemon({
  stateDir, port: 0, webDir: new URL('../dist/web', import.meta.url).pathname,
  configPath: null, mode: 'view', env: process.env,
});
const port = new URL(daemon.url).port;
const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on('pageerror', error => errors.push(String(error)));
try {
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' });
  await page.waitForSelector('#root > *', { timeout: 20000 });
  await page.goto(`http://127.0.0.1:${port}/#/tasks/t`, { waitUntil: 'load' });
  await page.waitForSelector('[data-testid="flow"]', { timeout: 25000 });
  await page.waitForTimeout(1500);
  // What the page itself received, not what the server would send: the two can differ.
  const api = await page.evaluate(async () => {
    const res = await fetch('/api/tasks/t/graph');
    const body = await res.json().catch(() => null);
    return { status: res.status, branches: body?.layout?.branches ?? null, edges: body?.layout?.edges?.length ?? null };
  });
  console.log('page saw:', JSON.stringify(api));
  const result = await page.evaluate(() => {
    // The branch label is drawn by the edge component itself: custom edges never got React Flow's
    // own label element, which is the defect this fix addresses. Read the SVG text we render.
    const labels = [...document.querySelectorAll('svg text')].map(node => node.textContent?.trim() ?? '');
    // Count what React Flow actually drew, and via which edge type, so a missing label is
    // distinguishable from a missing edge.
    const edgeTypes = [...document.querySelectorAll('.react-flow__edge')].map(e => e.className);
    const paths = [...document.querySelectorAll('path.react-flow__edge-path')].length;
    return {
      flow: Boolean(document.querySelector('[data-testid="flow"]')),
      branchLabels: labels.filter(label => label.startsWith('case:')),
      allLabels: labels,
      edgeCount: edgeTypes.length,
      paths,
      edgeClasses: edgeTypes.slice(0, 8),
    };
  });
  console.log(JSON.stringify(result, null, 2));
  await page.screenshot({ path: '/tmp/occham-evidence/branch-edges.png', fullPage: true });
  console.log('pageerrors', errors.length ? errors : 'none');
  const ok = result.flow
    && result.branchLabels.includes('case: pass')
    && result.branchLabels.includes('case: fail');
  console.log(ok ? 'PASS' : 'FAIL');
  process.exitCode = ok ? 0 : 1;
} finally {
  await browser.close();
  await daemon.close();
  store.close();
  await rm(root, { recursive: true, force: true });
}
