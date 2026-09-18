import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, expect, test } from 'vitest';
import { build } from 'vite';
import { chromium } from 'playwright';
import { openGraphServer } from '../../src/server/host.ts';
import { openaiServer } from '../fixtures/openai-server.ts';
import { createModelScheduler } from '../../src/runtime/model-scheduler.ts';
import type { NodeSpec } from '../../src/core/types.ts';

const cleanup: (() => Promise<void> | void)[] = [];
let webDir: string;
beforeAll(async () => {
  webDir = await mkdtemp(join(tmpdir(), 'graph-m8-records-web-'));
  await build({ configFile: join(process.cwd(), 'vite.config.ts'), logLevel: 'error', build: { outDir: webDir, emptyOutDir: true } });
}, 60_000);
afterEach(async () => {
  for (const action of cleanup.reverse()) {
    await Promise.race([Promise.resolve(action()).catch(() => undefined), new Promise(resolve => setTimeout(resolve, 5_000))]);
  }
  cleanup.length = 0;
});
afterAll(() => rm(webDir, { recursive: true, force: true }));

async function temp(name: string) {
  const dir = await mkdtemp(join(tmpdir(), `graph-m8-records-${name}-`));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

const usage = { input: 10, output: 10, cacheRead: 0, cacheWrite: 0 };
const injected = '<script>window.__pwned = true</script>';

async function waitFor(predicate: () => boolean, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for condition');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

test('success, failure, waiting and rework states are explained, answer isolation holds, and output stays text', async () => {
  const root = await temp('states');
  const artifact = { id: 'impl', path: join(root, 'impl.txt'), digest: 'a'.repeat(64) };
  const server = await openGraphServer({
    stateDir: join(root, 'state'), projects: [{ id: 'project', root }], webDir,
    startup: { mode: 'execute', configured: true, modelCount: 1, enabledModelCount: 1 },
    actions: {
      work: { kind: 'agent', reserveTokens: 100, prepare: async () => async () => ({ outcome: 'completed', output: { done: true }, artifacts: [artifact], usage }) },
      fail: { kind: 'agent', reserveTokens: 100, prepare: async () => async () => ({ outcome: 'failed', output: { error: injected }, usage }) },
      wait: { kind: 'agent', reserveTokens: 100, prepare: async () => async () => ({ outcome: 'waiting', output: { reason: '等待外部条件' }, question: { prompt: '等待外部条件' }, usage }) },
      review: {
        kind: 'agent', reserveTokens: 100,
        prepare: async () => async () => ({
          outcome: 'completed', usage,
          output: { schemaVersion: 1, subject: artifact, body: { kind: 'multiview', dimensions: { correctness: { verdict: 'fail', reason: '合成返工原因', evidence: [artifact] } } } },
        }),
      },
    },
  });
  cleanup.push(async () => { await Promise.race([server.close().catch(() => undefined), new Promise(resolve => setTimeout(resolve, 5_000))]); });
  server.runtime.catalog.publishDefinition('coder', { recommendedGrade: 'medium' }, 'coder');
  server.runtime.catalog.publishDefinition('reviewer', { recommendedGrade: 'high', review: true }, 'reviewer');
  const { taskId } = await server.runtime.user.begin({ projectId: 'project', request: '状态演示', requestId: 'begin' });
  const nodes: NodeSpec[] = [
    { id: 'ok', kind: 'agent', action: 'work', definitionVersion: 'coder@1', model: 'scripted' },
    { id: 'fail', kind: 'agent', action: 'fail', definitionVersion: 'coder@1', model: 'scripted' },
    { id: 'wait', kind: 'agent', action: 'wait', definitionVersion: 'coder@1', model: 'scripted' },
    { id: 'review', kind: 'agent', action: 'review', definitionVersion: 'reviewer@1', model: 'scripted' },
    { id: 'gate', kind: 'program', action: 'graph.verify', dependsOn: ['ok', 'review'], verifier: { kind: 'multiview', subjectNode: 'ok', reportNodes: ['review'], dimensions: [{ id: 'correctness', required: true, reportNode: 'review' }] } },
  ];
  await server.runtime.supervisor(taskId).propose({
    requirementVersion: 1, summary: '状态演示',
    acceptance: [{ id: 'works', description: '最终验收', checkNode: 'gate' }],
    nodes,
  }, 'proposal');
  await server.runtime.user.task(taskId).accept({ proposalVersion: 1, targetBranch: 'main', requestId: 'accept' });
  for (let round = 0; round < 3; round += 1) await server.runtime.host.runReady();
  const view = await server.runtime.user.task(taskId).view();
  expect(view.questions.map(question => question.kind).sort()).toEqual(['execution_failed', 'rework', 'waiting']);

  const browser = await chromium.launch({ headless: true });
  cleanup.push(() => browser.close());
  const page = await browser.newPage();
  await page.goto(`${server.url}/#/tasks/${taskId}`);
  await page.getByTestId('task').waitFor();
  const status = await page.getByTestId('status').innerText();
  expect(status).toContain('执行失败');
  expect(status).toContain('等待外部条件');
  expect(status).toContain('需要返工');
  const nodeList = await page.getByTestId('node-list').innerText();
  expect(nodeList).toContain('ok · 已完成');
  expect(nodeList).toContain('用量 未知');
  // External output is text, never trusted HTML.
  expect(await page.locator('body').innerText()).toContain(injected);
  expect(await page.evaluate(() => (window as unknown as { __pwned?: boolean }).__pwned)).toBeUndefined();

  // Answering the waiting question must not clear the other two.
  const questions = page.getByTestId('questions');
  expect(await questions.locator('li').count()).toBe(3);
  await questions.locator('li', { hasText: 'waiting' }).getByRole('button', { name: '答复' }).click();
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="questions"] li').length === 2);
  const remaining = await questions.locator('li').allInnerTexts();
  expect(remaining.join(' ')).toContain('execution_failed');
  expect(remaining.join(' ')).toContain('rework');
  // Retrying the failed node keeps the rework question open.
  await questions.locator('li', { hasText: 'execution_failed' }).getByRole('button', { name: '重试' }).click();
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="questions"] li').length === 1);
  expect(await questions.locator('li').allInnerTexts()).toEqual([expect.stringContaining('rework')]);

  // Node detail explains the missing usage and lists operation records.
  await page.goto(`${server.url}/#/tasks/${taskId}/graph`);
  await page.getByTestId('graph').waitFor();
  await page.locator('.react-flow__node').filter({ hasText: 'gate' }).first().click();
  const detail = await page.getByTestId('node-detail').innerText();
  expect(detail).toContain('未知（无权威计量）');
  expect(await page.getByTestId('operations-more').innerText()).toContain('加载更多');
}, 90_000);

test('a queued model request is displayed as waiting for a slot, not as running', async () => {
  const root = await temp('slot');
  const provider = await openaiServer([{ text: '完成', usage: null }]);
  cleanup.push(() => provider.close());
  const scheduler = createModelScheduler();
  const server = await openGraphServer({
    stateDir: join(root, 'state'), projects: [{ id: 'project', root }], webDir,
    startup: { mode: 'execute', configured: true, modelCount: 1, enabledModelCount: 1 },
    models: {
      entries: [{ id: 'local', provider: 'graph-openai', grade: 'high', api: 'openai-completions', baseUrl: provider.model.baseUrl, contextWindow: 32_000, maxTokens: 256, credentialId: 'cred' }],
      apiKey: 'k', modelRuntime: provider.runtime, modelScheduler: scheduler,
      credentialFor: () => ({ credentialId: 'cred', apiKey: 'k', limit: 1 }),
    },
    actions: { check: { kind: 'program', prepare: async () => async () => ({ outcome: 'completed', output: null, evidence: [{ acceptanceId: 'works', summary: 'ok', artifact: { path: join(root, 'ok'), digest: 'c'.repeat(64) } }] }) } },
  });
  cleanup.push(async () => { await Promise.race([server.close().catch(() => undefined), new Promise(resolve => setTimeout(resolve, 5_000))]); });
  server.runtime.catalog.publishDefinition('coder', { recommendedGrade: 'high' }, 'coder');
  const { taskId } = await server.runtime.user.begin({ projectId: 'project', request: '等待名额', requestId: 'begin' });
  await server.runtime.supervisor(taskId).propose({
    requirementVersion: 1, summary: '等待名额',
    acceptance: [{ id: 'works', description: 'Works', checkNode: 'check' }],
    nodes: [
      { id: 'work', kind: 'agent', action: 'work', definitionVersion: 'coder@1', model: 'local' },
      { id: 'check', kind: 'program', action: 'check', dependsOn: ['work'] },
    ],
  }, 'proposal');
  await server.runtime.user.task(taskId).accept({ proposalVersion: 1, targetBranch: 'main', requestId: 'accept' });
  const held = await scheduler.acquire({ credentialId: 'cred', limit: 1 });
  const driving = server.runtime.host.drive();
  await waitFor(() => scheduler.queued() === 1);
  const browser = await chromium.launch({ headless: true });
  cleanup.push(() => browser.close());
  const page = await browser.newPage();
  await page.goto(`${server.url}/#/tasks/${taskId}`);
  await page.getByTestId('task').waitFor();
  await page.waitForFunction(() => document.querySelector('[data-testid="node-list"]')?.textContent?.includes('等待 API 名额'));
  expect(provider.requests).toHaveLength(0);
  held();
  await driving;
  await page.waitForFunction(() => !document.querySelector('[data-testid="node-list"]')?.textContent?.includes('等待 API 名额'));
}, 90_000);

test('unknown usage is reconciled with an explicit reason and the delivery panel binds valid evidence', async () => {
  const root = await temp('usage');
  const provider = await openaiServer([{ text: '完成工作', usage: null }]);
  cleanup.push(() => provider.close());
  const server = await openGraphServer({
    stateDir: join(root, 'state'), projects: [{ id: 'project', root }], webDir,
    limits: { defaultBudgetTokens: 20_000_000 },
    startup: { mode: 'execute', configured: true, modelCount: 1, enabledModelCount: 1 },
    models: {
      entries: [{ id: 'local', provider: 'graph-openai', grade: 'high', api: 'openai-completions', baseUrl: provider.model.baseUrl, contextWindow: 32_000, maxTokens: 256 }],
      apiKey: 'scripted-local-key', modelRuntime: provider.runtime,
    },
    actions: {
      check: {
        kind: 'program',
        prepare: async () => async () => ({
          outcome: 'completed', output: { passed: true },
          evidence: [{ acceptanceId: 'works', summary: '检查通过', artifact: { path: join(root, 'ok.txt'), digest: 'b'.repeat(64) } }],
        }),
      },
    },
  });
  cleanup.push(async () => { await Promise.race([server.close().catch(() => undefined), new Promise(resolve => setTimeout(resolve, 5_000))]); });
  server.runtime.catalog.publishDefinition('coder', { recommendedGrade: 'high' }, 'coder');
  const { taskId } = await server.runtime.user.begin({ projectId: 'project', request: '未知用量', requestId: 'begin' });
  await server.runtime.supervisor(taskId).propose({
    requirementVersion: 1, summary: '未知用量',
    acceptance: [{ id: 'works', description: '检查通过', checkNode: 'check' }],
    nodes: [
      { id: 'work', kind: 'agent', action: 'work', definitionVersion: 'coder@1', model: 'local' },
      { id: 'check', kind: 'program', action: 'check', dependsOn: ['work'] },
    ],
  }, 'proposal');
  await server.runtime.user.task(taskId).accept({ proposalVersion: 1, targetBranch: 'main', requestId: 'accept' });
  await server.runtime.host.runReady();
  const questionKind = (await server.runtime.user.task(taskId).view()).questions.find(question => question.status === 'open')?.kind;
  expect(questionKind).toBe('unknown_usage');

  const browser = await chromium.launch({ headless: true });
  cleanup.push(() => browser.close());
  const page = await browser.newPage();
  await page.goto(`${server.url}/#/tasks/${taskId}`);
  await page.getByTestId('task').waitFor();
  expect(await page.getByTestId('status').innerText()).toContain('用量未知待核对');
  await page.getByTestId('usage-mode').selectOption('reconcile');
  await page.getByTestId('usage-proof').fill('供应商未返回 usage，无法核对，保留未知');
  await page.getByTestId('questions').getByRole('button', { name: '答复' }).click();
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="questions"] li').length === 0);

  await server.runtime.host.runReady();
  const view = await server.runtime.user.task(taskId).view();
  expect(view.invocations[0]?.cost).toMatchObject({ unknown: true });
  await page.waitForFunction(() => document.querySelector('[data-testid="delivery"]'));
  const delivery = await page.getByTestId('delivery').innerText();
  expect(delivery).toContain('目标分支 main');
  // Acceptance prepares the Git integration branch, so the panel shows its
  // commit instead of the old no-Git placeholder.
  expect(delivery).toContain('集成提交');
  expect(delivery).not.toContain('尚无集成提交');
  expect(delivery).toContain('检查通过');
  expect(delivery).not.toContain('无效或过期证据');
  expect(await page.evaluate(() => (window as unknown as { __pwned?: boolean }).__pwned)).toBeUndefined();
}, 90_000);
