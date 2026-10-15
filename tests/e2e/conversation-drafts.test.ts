import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, expect, test } from 'vitest';
import { build } from 'vite';
import { chromium } from 'playwright';
import { openGraphServer } from '../../src/server/host.ts';
import { fullAccessPolicy } from '../../src/core/access-policy.ts';
import type { NativeProposal } from '../../src/core/types.ts';
import { openaiServer, type ResponsePlan } from '../fixtures/openai-server.ts';

let webDir: string;
const cleanup: (() => Promise<void>)[] = [];
beforeAll(async () => {
  webDir = await mkdtemp(join(tmpdir(), 'graph-conversation-drafts-web-'));
  await build({ configFile: join(process.cwd(), 'vite.config.ts'), logLevel: 'error', build: { outDir: webDir, emptyOutDir: true } });
}, 60_000);
afterEach(async () => { for (const close of cleanup.reverse()) await close(); cleanup.length = 0; });
afterAll(async () => { await rm(webDir, { recursive: true, force: true }); });

function proposal(version: number, summary: string, decisions?: string[]): NativeProposal {
  return {
    requirementVersion: version, summary, ...(decisions === undefined ? {} : { decisions }),
    acceptance: [{ id: 'works', description: '检查通过', checkNode: 'check' }],
    definition: {
      schemaVersion: 2, name: summary, protocols: { data: { type: 'object' } },
      nodes: { work: { recipe: 'worker@1', model: 'worker', task: summary, inputs: { job: { protocol: 'data' } }, outputs: { result: { protocol: 'data' } }, submission: { required: ['result'] } } },
      modules: { check: { type: 'operation', trigger: 'each', inputs: { job: { protocol: 'data' } }, outputs: { result: { protocol: 'data' } }, operation: { action: 'workspace.command', version: 1, command: 'node', args: ['--version'], output: 'result' } } },
      edges: { checked: { from: 'work.result', to: 'check.job', enabled: true } }, inputs: {}, outputs: {},
      acceptance: [{ id: 'works', description: '检查通过', kind: 'check', module: 'check' }],
    },
  };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'graph-conversation-drafts-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  for (const name of ['a', 'b']) {
    const project = join(root, name); await mkdir(project);
    await writeFile(join(project, 'README.md'), `Real project ${name}\n`);
    const git = (args: string[]) => execFileSync('git', ['-C', project, ...args], { encoding: 'utf8' });
    git(['init', '-q', '-b', 'main']); git(['add', '.']);
    git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Initial project']);
  }
  const mainPlans: ResponsePlan[] = [];
  const main = await openaiServer(mainPlans);
  const worker = await openaiServer([
    { tools: [{ id: 'result', name: 'submit', arguments: JSON.stringify({ outputs: { result: { enable: true, value: {} } } }) }] },
    { text: 'The worker submitted its result.' },
  ]);
  const cheap = await openaiServer(Array.from({ length: 12 }, () => ({ text: '没有建议' })));
  for (const provider of [main, worker, cheap]) cleanup.push(() => provider.close());
  const server = await openGraphServer({
    stateDir: join(root, 'state'), webDir, autoDrive: true, access: () => fullAccessPolicy(),
    projects: ['a', 'b'].map(id => ({ id, root: join(root, id) })),
    catalog: { capabilityRoot: join(root, 'capabilities'), recipesPath: join(root, 'recipes.json') },
    models: { apiKey: 'local-synthetic-key', modelRuntime: main.runtime, entries: ([['main', main], ['worker', worker], ['cheap', cheap]] as const).map(([id, provider]) => ({
      id, provider: provider.model.provider, grade: id === 'cheap' ? 'low' : 'high', api: 'openai-completions', baseUrl: provider.model.baseUrl, contextWindow: 32_000, maxTokens: 256,
    })) },
    master: { action: 'master', definitionVersion: 'master@1', model: 'main' },
  });
  cleanup.push(() => server.close());
  for (const name of ['master', 'worker']) server.runtime.catalog.publishDefinition(name, { recommendedGrade: 'high' }, name);
  const browser = await chromium.launch({ headless: true }); cleanup.push(() => browser.close());
  const context = await browser.newContext({ extraHTTPHeaders: { origin: server.url } });
  const page = await context.newPage();
  expect((await page.request.get(server.url)).ok()).toBe(true);
  async function get(path: string) { const response = await page.request.get(`${server.url}${path}`); expect(response.ok(), await response.text()).toBe(true); return response.json(); }
  async function post(path: string, data: Record<string, unknown> = {}) {
    const response = await page.request.post(`${server.url}${path}`, { data: { requestId: crypto.randomUUID(), ...data } });
    expect(response.ok(), await response.text()).toBe(true); return response.json();
  }
  async function refused(path: string, data: Record<string, unknown>, code: string) {
    const response = await page.request.post(`${server.url}${path}`, { data: { requestId: crypto.randomUUID(), ...data } });
    expect(response.status()).toBe(400); expect(await response.json()).toMatchObject({ code });
  }
  const view = (id: string) => get(`/api/conversations/${id}`);
  async function open(id: string) { await page.goto(`${server.url}/#/conversations/${id}`); await page.locator('[data-testid="conversation"]:visible').getByTestId('chat-input').waitFor(); }
  async function create(text = 'Discuss the smallest useful feature') {
    mainPlans.push({ text: 'The main conversation is ready.' });
    const result = await post('/api/conversations', { projectId: 'a', text });
    await open(result.conversationId);
    await expect.poll(async () => (await view(result.conversationId)).master.status, { timeout: 30_000 }).toBe('succeeded');
    await post(`/api/conversations/${result.conversationId}/pause`);
    return result as { conversationId: string; taskId: string };
  }
  async function confirm(id: string, version: number, revision: number, requestId = crypto.randomUUID()) {
    return post(`/api/conversations/${id}/confirm`, { proposalVersion: version, draftRevision: revision, targetBranch: 'main', requestId });
  }
  async function turn(id: string, text: string, tool?: { name: string; arguments: Record<string, unknown> }) {
    const toolId = crypto.randomUUID();
    if (tool) mainPlans.push({ tools: [{ id: toolId, name: tool.name, arguments: JSON.stringify(tool.arguments) }] });
    mainPlans.push({ text: `Completed: ${text}` });
    const before = main.requests.length;
    await post(`/api/conversations/${id}/messages`, { text });
    await post(`/api/conversations/${id}/resume`);
    await expect.poll(() => main.requests.length, { timeout: 30_000 }).toBe(before + (tool ? 2 : 1));
    await expect.poll(async () => (await view(id)).master.status, { timeout: 30_000 }).toBe('succeeded');
    await post(`/api/conversations/${id}/pause`);
    if (!tool) return '';
    // Read an authentic tool result that the SDK sent back to the real provider.
    const followup = main.requests.at(-1) as { messages: { role: string; tool_call_id?: string; content: unknown }[] };
    const result = followup.messages.find(message => message.role === 'tool' && message.tool_call_id === toolId);
    expect(result, `native ${tool.name} must execute, not merely appear in the request`).toBeDefined();
    return typeof result!.content === 'string' ? result!.content : JSON.stringify(result!.content);
  }
  async function draft(id: string, requirementVersion: number, summary: string, newVersion = false) {
    const result = await turn(id, `Propose: ${summary}`, { name: 'propose_graph', arguments: {
      proposal: proposal(requirementVersion, summary), newVersion, requestId: crypto.randomUUID(),
    } });
    expect(result).toContain('proposalVersion');
    return (await view(id)).proposal;
  }
  async function drawer(id: string, summary: string, version: number) {
    await open(id);
    if (await page.getByTestId('drawer-entry').getAttribute('data-open') !== 'true') await page.getByTestId('drawer-entry').click();
    await page.getByTestId(`drawer-draft-version-${version}`).click();
    await expect.poll(() => page.getByTestId(`drawer-draft-version-${version}`).getAttribute('data-active')).toBe('true');
    await expect.poll(() => page.getByTestId('drawer-draft-summary').innerText(), { timeout: 30_000 }).toBe(summary);
  }
  return { server, main, worker, page, get, post, refused, view, open, create, confirm, turn, draft, drawer };
}

test('reviewed draft credentials survive in-place edits and explicit versions without confirming unseen content', async () => {
  const f = await fixture();
  const { conversationId: id, taskId: anchor } = await f.create();
  const main = f.server.runtime.supervisor(anchor);
  await f.draft(id, 1, 'Original reviewed content');
  const first = (await f.view(id)).proposal;
  expect(first).toMatchObject({ version: 1, draftRevision: 1, spec: { summary: 'Original reviewed content' } });
  expect(first.draftDigest).toMatch(/^[a-f0-9]{64}$/);
  await f.draft(id, 1, 'Edited content');
  const edited = (await f.view(id)).proposal;
  expect(edited).toMatchObject({ version: 1, draftRevision: 2, spec: { summary: 'Edited content' } });
  expect(edited.draftDigest).not.toBe(first.draftDigest);
  expect((await f.view(id)).proposalHistory.map((item: { version: number }) => item.version)).toEqual([1]);
  await f.refused(`/api/conversations/${id}/confirm`, { proposalVersion: 1, draftRevision: first.draftRevision, targetBranch: 'main' }, 'stale_proposal');
  await f.draft(id, 1, 'Explicit second version', true);
  const latest = await f.view(id);
  expect(latest.proposal).toMatchObject({ version: 2, draftRevision: 1, spec: { summary: 'Explicit second version' } });
  expect(latest.proposalHistory.map((item: { version: number; summary: string }) => [item.version, item.summary])).toEqual([[1, 'Edited content'], [2, 'Explicit second version']]);
  expect((await f.get(`/api/conversations/${id}/proposals/1`)).spec.summary).toBe('Edited content');
  const missing = await f.page.request.get(`${f.server.url}/api/conversations/${id}/proposals/99`);
  expect(missing.status()).toBe(400); expect(await missing.json()).toMatchObject({ code: 'not_found' });
  expect(latest.proposalHistory.map((item: { version: number; accepted: boolean; stale: boolean }) => [item.version, item.accepted, item.stale])).toEqual([[1, false, false], [2, false, false]]);
  await f.refused(`/api/conversations/${id}/confirm`, { proposalVersion: 1, draftRevision: edited.draftRevision, targetBranch: 'main' }, 'stale_proposal');
  await f.drawer(id, 'Explicit second version', 2);
  const draftTab = f.page.locator(`.tab[data-kind="draft"][data-tab-key="${id}"]`);
  const conversationTab = f.page.locator(`.tab[data-kind="conversation"][data-tab-key="${id}"]`);
  await f.page.getByTestId('drawer-draft-version-1').click();
  await expect.poll(() => f.page.getByTestId('drawer-entry-graph').getAttribute('href')).toBe(`#/conversations/${id}/graph?v=1`);
  await f.page.getByTestId('drawer-entry-graph').click();
  await f.page.getByTestId('draft-graph-tab').waitFor();
  await expect.poll(() => f.page.getByTestId('conversation-graph-title').innerText()).toBe('Edited content');
  await expect.poll(() => f.page.evaluate(() => location.hash)).toBe(`#/conversations/${id}/graph?v=1`);
  expect(await draftTab.count()).toBe(1);
  await f.page.getByTestId('rail-usage').click();
  await draftTab.locator('.tab-open').click();
  await expect.poll(() => f.page.evaluate(() => location.hash)).toBe(`#/conversations/${id}/graph?v=1`);
  await expect.poll(() => f.page.getByTestId('conversation-graph-title').innerText()).toBe('Edited content');
  // Refresh that same draft destination to actual v2 using the real drawer link.
  await conversationTab.locator('.tab-open').click();
  if (await f.page.getByTestId('drawer-entry').getAttribute('data-open') !== 'true') await f.page.getByTestId('drawer-entry').click();
  await f.page.getByTestId('drawer-draft-version-2').click();
  await expect.poll(() => f.page.getByTestId('drawer-entry-graph').getAttribute('href')).toBe(`#/conversations/${id}/graph?v=2`);
  await f.page.getByTestId('drawer-entry-graph').click();
  await expect.poll(() => f.page.getByTestId('conversation-graph-title').innerText()).toBe('Explicit second version');
  await f.page.getByTestId('rail-usage').click();
  await draftTab.locator('.tab-open').click();
  await expect.poll(() => f.page.evaluate(() => location.hash)).toBe(`#/conversations/${id}/graph?v=2`);
  await expect.poll(() => f.page.getByTestId('conversation-graph-title').innerText()).toBe('Explicit second version');
  expect(await draftTab.count()).toBe(1);
  expect(await conversationTab.count()).toBe(1);
  // Return the original workflow to its actual conversation before its reload/confirm.
  await conversationTab.locator('.tab-open').click();
  await f.page.locator('[data-testid="conversation"]:visible').getByTestId('chat-input').waitFor();
  await f.page.reload();
  const entry = f.page.getByTestId('drawer-entry');
  if (await entry.getAttribute('data-open') !== 'true') await entry.click();
  await expect.poll(() => f.page.getByTestId('drawer-draft-summary').innerText()).toBe('Explicit second version');
  const requestId = crypto.randomUUID();
  const accepted = await f.confirm(id, 2, 1, requestId);
  expect(await f.confirm(id, 2, 1, requestId)).toEqual(accepted);
  const view = await f.view(id);
  expect(view.requirementVersion).toBe(2);
  expect(view.tasks.map((item: { id: string }) => item.id)).toEqual([accepted.taskId]);
  expect(view.tasks[0]).toMatchObject({ phase: 'running', nodes: [{ id: 'work', status: 'idle' }] });
  expect(view.proposalHistory.map((item: { version: number; accepted: boolean; stale: boolean }) => [item.version, item.accepted, item.stale])).toEqual([[1, false, true], [2, true, true]]);
  expect((await f.get(`/api/conversations/${id}/proposals/2`)).stale).toBe(true);
  expect(view.proposal.stale).toBe(true);
  await f.refused(`/api/conversations/${id}/confirm`, { proposalVersion: 2, draftRevision: 1, targetBranch: 'main' }, 'stale_proposal');
  expect(await main.graphState()).toMatchObject({ relatedTasks: [{ taskId: accepted.taskId, graphVersion: 1, nodes: [{ id: 'work', origin: 'v2', status: 'idle' }] }] });
  expect(await main.graphInspect({ graphId: accepted.taskId, query: 'revision' })).toMatchObject({ modules: { check: { type: 'operation', operation: { action: 'workspace.command' } } }, edges: { checked: { from: 'work.result', to: 'check.job', enabled: true } } });
  expect(view.accepted.map((item: { proposalVersion: number; draftRevision: number }) => [item.proposalVersion, item.draftRevision])).toEqual([[2, 1]]);
  expect(await main.graphInspect({ graphId: accepted.taskId, query: 'queue' })).toMatchObject({ items: [] });
  expect(await f.get('/api/tasks')).toMatchObject([{ id: accepted.taskId }]);
  await f.draft(id, 2, 'Later feature draft');
  expect((await f.view(id)).proposal).toMatchObject({ version: 3, spec: { summary: 'Later feature draft' } });
  expect((await f.get(`/api/conversations/${id}/proposals/2`)).spec.summary).toBe('Explicit second version');
  expect(await main.graphInspect({ graphId: accepted.taskId, query: 'revision' })).toMatchObject({ name: 'Explicit second version', nodes: { work: { task: 'Explicit second version' } } });
  expect(f.worker.requests).toHaveLength(0);
  const other = await f.create('Review an edited draft without allocating another version');
  await f.draft(other.conversationId, 1, 'Same-version initial');
  const oldCredential = (await f.view(other.conversationId)).proposal.draftRevision;
  await f.draft(other.conversationId, 1, 'Same-version replacement');
  await f.refused(`/api/conversations/${other.conversationId}/confirm`, { proposalVersion: 1, draftRevision: oldCredential, targetBranch: 'main' }, 'stale_proposal');
  const revised = (await f.view(other.conversationId)).proposal;
  const revisedTask = await f.confirm(other.conversationId, 1, revised.draftRevision);
  const revisedView = await f.view(other.conversationId);
  expect(revisedView.tasks.map((item: { id: string }) => item.id)).toEqual([revisedTask.taskId]);
  expect(revisedView.accepted.map((item: { proposalVersion: number; draftRevision: number }) => [item.proposalVersion, item.draftRevision])).toEqual([[1, 2]]);
}, 180_000);

test('archive, restore, deletion and withdrawal keep independent cards and monotonic version identities', async () => {
  const f = await fixture();
  const { conversationId: id, taskId: anchor } = await f.create();
  const main = f.server.runtime.supervisor(anchor);
  await f.draft(id, 1, 'First version');
  await f.draft(id, 1, 'Second version', true);
  await f.drawer(id, 'Second version', 2);
  await f.page.getByTestId('archive-draft').click();
  await expect.poll(async () => (await f.view(id)).proposal).toBeNull();
  await f.post(`/api/conversations/${id}/drafts/archive`, { proposalVersion: 1 });
  const archived = await f.view(id);
  expect(archived.proposal).toBeNull(); expect(archived.proposalHistory).toEqual([]);
  expect(archived.archivedProposals.map((item: { version: number }) => item.version)).toEqual([1, 2]);
  expect(await f.get(`/api/conversations/${id}/proposals/1`)).toMatchObject({ archived: true, spec: { summary: 'First version' } });
  expect(await main.graphState()).toMatchObject({ proposal: null, archivedProposals: [{ version: 1 }, { version: 2 }] });
  expect((await f.get(`/api/tasks/${anchor}`)).proposal).toBeNull();
  await f.refused(`/api/conversations/${id}/confirm`, { proposalVersion: 2, draftRevision: 1, targetBranch: 'main' }, 'stale_proposal');
  await f.page.reload();
  if (await f.page.getByTestId('drawer-entry').getAttribute('data-open') !== 'true') await f.page.getByTestId('drawer-entry').click();
  await f.page.getByTestId('archived-draft-1').waitFor();
  expect(await f.page.getByTestId('archived-draft-2').innerText()).toContain('Second version');
  await f.page.getByTestId('restore-draft-1').click();
  await expect.poll(async () => (await f.view(id)).proposal).toMatchObject({ version: 1, spec: { summary: 'First version' } });
  const immediatelyRestored = await f.view(id);
  expect(immediatelyRestored.proposalHistory.map((item: { version: number }) => item.version)).toEqual([1]);
  expect(immediatelyRestored.archivedProposals.map((item: { version: number }) => item.version)).toEqual([2]);
  await f.draft(id, 1, 'Restored first version edited');
  const restored = await f.view(id);
  expect(restored.proposal).toMatchObject({ version: 1, draftRevision: 2, spec: { summary: 'Restored first version edited' } });
  expect(restored.proposal.spec.summary).toBe('Restored first version edited');
  expect(restored.proposalHistory.map((item: { version: number }) => item.version)).toEqual([1]);
  expect(restored.archivedProposals.map((item: { version: number }) => item.version)).toEqual([2]);
  await f.draft(id, 1, 'Third version', true);
  const third = await f.view(id);
  expect(third.proposal.version).toBe(3);
  expect(third.proposalHistory.map((item: { version: number }) => item.version)).toEqual([1, 3]);
  expect(third.archivedProposals.map((item: { version: number }) => item.version)).toEqual([2]);
  await f.post(`/api/conversations/${id}/drafts/delete`, { proposalVersion: 3 });
  const missing = await f.page.request.get(`${f.server.url}/api/conversations/${id}/proposals/3`);
  expect(missing.status()).toBe(400); expect(await missing.json()).toMatchObject({ code: 'not_found' });
  await f.refused(`/api/conversations/${id}/drafts/restore`, { proposalVersion: 3 }, 'not_found');
  // Default creation after deletion must respect the same tombstone high-water.
  await f.draft(id, 1, 'Fourth version');
  const fourth = await f.view(id);
  expect(fourth.proposal.version).toBe(4);
  expect(fourth.proposalHistory.map((item: { version: number }) => item.version)).toEqual([1, 4]);
  expect(fourth.archivedProposals.map((item: { version: number }) => item.version)).toEqual([2]);
  expect(await f.turn(id, 'Withdraw missing draft', { name: 'withdraw_draft', arguments: { proposalVersion: 99, requestId: crypto.randomUUID() } })).toContain('That draft does not exist');
  const withdrawnReceipt = JSON.parse(await f.turn(id, 'Withdraw current draft because 方向已变', { name: 'withdraw_draft', arguments: { proposalVersion: 4, reason: '方向已变', requestId: crypto.randomUUID() } }));
  expect(withdrawnReceipt).toMatchObject({ withdrawnVersion: 4, nextProposalVersion: 5 });
  const withdrawn = await f.view(id);
  expect(withdrawn.proposal).toBeNull();
  expect(withdrawn.proposalHistory.map((item: { version: number }) => item.version)).toEqual([1, 4]);
  expect(withdrawn.messages.some((item: { role: string; text: string }) => item.role === 'system' && item.text.includes('已作废：方向已变'))).toBe(true);
  await f.refused(`/api/conversations/${id}/confirm`, { proposalVersion: 4, draftRevision: 1, targetBranch: 'main' }, 'stale_proposal');
  expect(await f.turn(id, 'Withdraw already withdrawn draft', { name: 'withdraw_draft', arguments: { proposalVersion: 4, requestId: crypto.randomUUID() } })).toContain('Only the current draft can be withdrawn');
  await f.draft(id, 1, 'Sixth version');
  expect((await f.view(id)).proposal.version).toBe(6);
  expect((await f.get(`/api/conversations/${id}/proposals/2`)).spec.summary).toBe('Second version');
  expect(f.worker.requests).toHaveLength(0);
}, 120_000);

test('deleting a confirmed source card preserves the real worker session, acceptance, graph and conversation context', async () => {
  const f = await fixture();
  const { conversationId: id, taskId: anchor } = await f.create('约束：预算有限，登录先不改。');
  const main = f.server.runtime.supervisor(anchor);
  await f.draft(id, 1, 'Confirmed source to delete');
  const accepted = await f.confirm(id, 1, 1);
  await f.turn(id, '现在卡在哪里？');
  const idlePrompt = JSON.stringify(f.main.requests.at(-1));
  expect(idlePrompt).toContain('现在卡在哪里？');
  expect(idlePrompt).toContain(accepted.taskId.slice(0, 8));
  expect(idlePrompt).toContain('Feature task'); expect(idlePrompt).toContain('work:idle');
  expect((await f.view(id)).requirementVersion).toBe(2);
  await main.graphSend({ graphId: accepted.taskId, nodeId: 'work', input: 'job', value: {} });
  await expect.poll(async () => (await f.get(`/api/tasks/${accepted.taskId}/nodes/work/run`)).node.status, { timeout: 30_000 }).toBe('succeeded');
  expect(f.worker.requests).toHaveLength(2);
  const workerPrompt = JSON.stringify(f.worker.requests[0]);
  expect(workerPrompt).toContain('Decisions and constraints from the conversation');
  expect(workerPrompt).toContain('预算有限，登录先不改');
  expect(workerPrompt).not.toContain('Conversation and execution status');
  await f.turn(id, '执行完成了吗？');
  const donePrompt = JSON.stringify(f.main.requests.at(-1));
  expect(donePrompt).toContain('执行完成了吗？'); expect(donePrompt).toContain('work:succeeded');
  expect((await f.view(id)).requirementVersion).toBe(2);
  // All provenance here comes from the actual native producer; these are read-only snapshots.
  await expect.poll(async () => {
    const operations = await main.graphInspect({ graphId: accepted.taskId, query: 'operations' }) as { module_id: string; state: string }[];
    return operations.find(item => item.module_id === 'check')?.state;
  }, { timeout: 30_000 }).toMatch(/^(settled|failed)$/);
  const beforeRun = await f.get(`/api/tasks/${accepted.taskId}/nodes/work/run`);
  expect(beforeRun.entries.length).toBeGreaterThan(0);
  expect(beforeRun.session.sessionId).toEqual(expect.any(String));
  const beforeAcceptance = await main.graphInspect({ graphId: accepted.taskId, query: 'acceptance' }) as { items: unknown[] };
  expect(beforeAcceptance.items.length).toBeGreaterThan(0);
  const beforeRevision = await main.graphInspect({ graphId: accepted.taskId, query: 'revision' });
  const beforeConversation = await f.view(id);
  await f.post(`/api/conversations/${id}/drafts/delete`, { proposalVersion: 1 });
  const after = await f.view(id);
  expect(after.proposal).toBeNull(); expect(after.proposalHistory).toEqual([]); expect(after.archivedProposals).toEqual([]);
  const missing = await f.page.request.get(`${f.server.url}/api/conversations/${id}/proposals/1`);
  expect(missing.status()).toBe(400); expect(await missing.json()).toMatchObject({ code: 'not_found' });
  expect(after.messages).toEqual(beforeConversation.messages);
  expect(after.tasks.map((item: { id: string }) => item.id)).toEqual([accepted.taskId]);
  expect(after.tasks[0].acceptedProposalVersion).toBe(1);
  const afterRun = await f.get(`/api/tasks/${accepted.taskId}/nodes/work/run`);
  expect(afterRun.node.status).toBe('succeeded'); expect(afterRun.entries).toEqual(beforeRun.entries);
  expect(afterRun.session).toEqual(beforeRun.session);
  expect(await main.graphInspect({ graphId: accepted.taskId, query: 'acceptance' })).toEqual(beforeAcceptance);
  expect(await main.graphInspect({ graphId: accepted.taskId, query: 'revision' })).toEqual(beforeRevision);
  expect((await f.get('/api/tasks')).map((item: { id: string }) => item.id)).toEqual([accepted.taskId]);
}, 180_000);

test('rebinding and another feature preserve confirmed scope while draft cards stay owned by their conversation', async () => {
  const f = await fixture();
  const { conversationId: id, taskId: anchor } = await f.create('Investigate only project A');
  const main = f.server.runtime.supervisor(anchor);
  await f.draft(id, 1, 'A reviewed draft');
  const other = await f.create('An independent conversation');
  await f.draft(other.conversationId, 1, 'Other conversation draft');
  await f.post(`/api/conversations/${other.conversationId}/drafts/archive`, { proposalVersion: 1 });
  expect((await f.view(id)).proposal.spec.summary).toBe('A reviewed draft');
  expect((await f.view(id)).archivedProposals).toEqual([]);
  expect((await f.view(other.conversationId)).proposal).toBeNull();
  expect((await f.view(other.conversationId)).archivedProposals.map((item: { version: number }) => item.version)).toEqual([1]);
  const rebound = await f.post(`/api/conversations/${id}/bind`, { projectId: 'b' });
  expect(rebound).toMatchObject({ invalidatedDrafts: true });
  const afterBind = await f.view(id);
  expect(afterBind).toMatchObject({ projectId: 'b', requirementVersion: 2, proposal: { stale: true } });
  await f.refused(`/api/conversations/${id}/confirm`, { proposalVersion: 1, draftRevision: 1, targetBranch: 'main' }, 'stale_proposal');
  await f.draft(id, 2, 'B reviewed feature');
  const first = await f.confirm(id, 2, 1);
  const firstTask = await f.get(`/api/tasks/${first.taskId}`);
  expect(firstTask).toMatchObject({ projectId: 'b', phase: 'running', acceptedProposalVersion: 1 });
  await f.turn(id, '顺便加上另一平台。');
  await f.draft(id, 3, 'Another platform');
  const laterDraft = await f.view(id);
  expect(laterDraft.proposal.version).toBe(3);
  expect((await f.get(`/api/conversations/${id}/proposals/2`)).spec.summary).toBe('B reviewed feature');
  expect(await main.graphInspect({ graphId: first.taskId, query: 'revision' })).toMatchObject({ name: 'B reviewed feature' });
  const second = await f.confirm(id, 3, 1);
  expect(second.taskId).not.toBe(first.taskId);
  const after = await f.view(id);
  expect(after.tasks.map((item: { id: string }) => item.id)).toEqual([first.taskId, second.taskId]);
  expect(after.tasks.map((item: { phase: string }) => item.phase)).toEqual(['running', 'queued']);
  expect(after.requirementVersion).toBe(4);
  const unchanged = await f.get(`/api/tasks/${first.taskId}`);
  expect(unchanged).toMatchObject({ acceptedProposalVersion: 1, phase: 'running' });
  expect(unchanged.proposal.acceptance.map((item: { description: string }) => item.description)).toEqual(['检查通过']);
  // The confirmed B copy survives a later A binding and a fourth source draft.
  await f.post(`/api/conversations/${id}/bind`, { projectId: 'a' });
  expect((await f.view(id)).requirementVersion).toBe(5);
  await f.draft(id, 5, 'New project A direction');
  expect((await f.view(id)).proposal.version).toBe(4);
  expect((await f.get(`/api/conversations/${id}/proposals/3`)).spec.summary).toBe('Another platform');
  expect((await f.get(`/api/conversations/${id}/proposals/2`)).spec.summary).toBe('B reviewed feature');
  expect(await main.graphInspect({ graphId: first.taskId, query: 'revision' })).toMatchObject({ name: 'B reviewed feature', nodes: { work: { task: 'B reviewed feature' } } });
  expect((await f.get(`/api/tasks/${first.taskId}`)).projectId).toBe('b');
  expect(f.worker.requests).toHaveLength(0);
}, 180_000);
