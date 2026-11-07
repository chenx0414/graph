import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';

import { createServer, type Server } from 'node:http';

import type { AddressInfo } from 'node:net';

import { execFileSync } from 'node:child_process';

import { tmpdir } from 'node:os';

import { join } from 'node:path';

import { afterEach, beforeAll, expect, test } from 'vitest';

import { build } from 'vite';

import { chromium } from 'playwright';

import { launchCli } from '../helpers/cli-daemon.ts';
import { cleanup, webDir, temp, git, gitProject, consoleServer, type ScriptedStep, type ScriptedToolCall, type ScriptedMessage, type ScriptedBody, scriptedProvider, libraryPrompt, libraryDisabledTools, workerProposal, createConversation, conversationView, type Daemon, type ConversationView, taskView, catalogView } from "./app-shell-ux.fixture.ts";



test('the Main Agent recipe is visible with fixed system capabilities and an editable capability recipe', async () => {
  const root = await temp('main-agent-recipe');
  const capabilityRoot = join(root, 'graph', 'capabilities');
  const skill = join(capabilityRoot, 'main-research');
  await mkdir(skill, { recursive: true });
  await writeFile(join(skill, 'SKILL.md'), '# Main research\n');
  await writeFile(join(skill, 'capability.json'), JSON.stringify({
    id: 'main-research',
    kind: 'skill',
    version: '1.0.0',
    name: 'Main Agent Research',
  }));
  const recipesPath = join(root, 'graph', 'agent-combinations.json');
  await writeFile(recipesPath, JSON.stringify({
    version: 1,
    combinations: [{
      id: 'main',
      name: 'Main Agent',
      description: '主 Agent 配方。',
      mode: 'main',
      recommendedGrade: 'high',
      review: false,
      tags: ['main'],
      resources: [],
    }],
  }));
  const server = await consoleServer(root, { projects: [{ id: 'alpha', root }] });

  const browser = await chromium.launch({ headless: true });
  cleanup.push(() => browser.close());
  const page = await browser.newPage();
  await page.goto(`${server.url}/#/catalog/agents`);
  await page.getByTestId('agent-combination-main').waitFor();
  expect(await page.getByTestId('main-agent-system-capabilities').innerText()).toContain('任务规划');
  expect(await page.getByTestId('main-agent-system-capabilities').innerText()).toContain('监控 Graph 全程');
  await page.getByTestId('agent-combination-main').getByRole('button', { name: '编辑' }).click();
  await page.getByTestId('main-agent-recipe-note').waitFor();
  expect(await page.getByTestId('agent-recipe-id').isDisabled()).toBe(true);
  expect(await page.getByTestId('main-agent-recipe-note').innerText()).toContain('不能从配方移除');
  await page.getByRole('button', { name: '取消' }).click();
  expect(await page.getByTestId('agent-combination-main').getByRole('button', { name: '删除' }).isDisabled()).toBe(true);
}, 60_000);



test('the composer inserts project file mentions and carries text attachments into the message ledger', async () => {
  const root = await temp('composer-context');
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', 'index.ts'), 'export const value = 1;\n');
  const server = await consoleServer(root, { projects: [{ id: 'alpha', root }] });
  const created = await createConversation(server, { projectId: 'alpha', text: '先讨论', requestId: 'composer-context' });

  const browser = await chromium.launch({ headless: true });
  cleanup.push(() => browser.close());
  const page = await browser.newPage();
  await page.goto(`${server.url}/#/conversations/${created.conversationId}`);
  const input = page.getByTestId('chat-input');
  await input.waitFor();
  await input.fill('请看 @src');
  await page.getByTestId('mention-popover').waitFor();
  await page.getByTestId('mention-file-src/index.ts').waitFor();
  await input.press('ArrowDown');
  await input.press('Enter');
  expect(await input.evaluate((element: HTMLInputElement) => element.value)).toBe('请看 @src/index.ts ');

  await page.getByTestId('chat-attachment-input').setInputFiles({
    name: 'notes.md',
    mimeType: 'text/markdown',
    buffer: Buffer.from('# Notes\n\nAttachment body.\n'),
  });
  await page.getByTestId('composer-attachments').waitFor();
  expect(await page.getByTestId('composer-attachments').innerText()).toContain('notes.md');
  await page.getByTestId('chat-send').click();
  await expect.poll(async () => {
    const view = await conversationView(server, created.conversationId);
    return ((view.messages.at(-1)?.data as { attachments?: unknown } | null)?.attachments) instanceof Array;
  }).toBe(true);
  const view = await conversationView(server, created.conversationId);
  const message = view.messages.at(-1)!;
  expect(message.text).toContain('@src/index.ts');
  expect((message.data as { attachments?: unknown } | null)?.attachments).toEqual([
    { name: 'notes.md', type: 'text/markdown', size: 26, text: '# Notes\n\nAttachment body.\n' },
  ]);
  await expect.poll(() => page.getByTestId('message-user').last().innerText()).toContain('notes.md');
}, 60_000);



test('the composer slash menu selects tools, switches model and queues compaction', async () => {
  const root = await temp('composer-slash');
  const server = await consoleServer(root, { projects: [{ id: 'alpha', root }], models: 2 });
  // The conversation starts at the lowest strength, so the console has to
  // carry a real level for a model that offers no list of its own.
  const created = await createConversation(server, { projectId: 'alpha', text: '先讨论', requestId: 'composer-slash', thinkingLevel: 'minimal' });

  const browser = await chromium.launch({ headless: true });
  cleanup.push(() => browser.close());
  const page = await browser.newPage();
  const modelRequests: unknown[] = [];
  let compactRequests = 0;
  let sent: { text?: string } | null = null;
  await page.route('**/api/settings', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      projects: [{ id: 'alpha', root }],
      defaultModel: 'local',
      models: [
        { id: 'local', grade: 'high', credentialId: 'local', contextWindow: 32_000, reasoning: true, defaultThinkingLevel: 'low' },
        { id: 'fast', grade: 'medium', credentialId: 'local', contextWindow: 16_000, reasoning: false },
      ],
      definitions: [],
      capabilities: [],
    }),
  }));
  await page.route(`**/api/conversations/${created.conversationId}/model`, async route => {
    modelRequests.push(JSON.parse(route.request().postData() ?? '{}'));
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ changed: true }) });
  });
  await page.route(`**/api/conversations/${created.conversationId}/compact`, async route => {
    compactRequests += 1;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ state: 'pending' }) });
  });
  await page.route(`**/api/conversations/${created.conversationId}/messages`, async route => {
    sent = JSON.parse(route.request().postData() ?? '{}') as { text?: string };
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ conversationId: created.conversationId, messageId: 'message', state: 'pending', cursor: 2, pending: false }),
    });
  });

  await page.goto(`${server.url}/#/conversations/${created.conversationId}`);
  const input = page.getByTestId('chat-input');
  await input.waitFor();

  await input.fill('/model');
  const slashPopover = page.getByTestId('slash-popover');
  await slashPopover.waitFor();
  const popoverBox = await slashPopover.boundingBox();
  const viewport = page.viewportSize();
  expect(popoverBox).not.toBeNull();
  expect(viewport).not.toBeNull();
  expect(popoverBox!.y).toBeGreaterThanOrEqual(0);
  expect(popoverBox!.y + popoverBox!.height).toBeLessThanOrEqual(viewport!.height);
  await page.getByTestId('slash-system-model').click();
  await page.getByTestId('slash-model-fast').click();
  await expect.poll(() => modelRequests.length).toBe(1);
  // Thinking is always on, so a model without a level list gets its lowest one.
  expect(modelRequests[0]).toMatchObject({ model: 'fast', thinkingLevel: 'minimal' });

  await input.fill('/compact');
  await page.getByTestId('slash-system-compact').click();
  await expect.poll(() => compactRequests).toBe(1);

  await input.fill('/');
  await page.getByTestId('slash-tool-read').click();
  await expect.poll(() => input.evaluate((element: HTMLInputElement) => element.value)).toBe('/read ');
  expect(await page.getByTestId('composer-command-chips').count()).toBe(0);
  await input.fill(`${await input.evaluate((element: HTMLInputElement) => element.value)}请分析这个项目`);
  await page.getByTestId('chat-send').click();
  await expect.poll(() => sent).not.toBeNull();
  expect(sent!.text).toContain('/read ');
  expect(sent!.text).toContain('请分析这个项目');
  expect(sent!.text).toContain('The user explicitly requested the following tools and capabilities');
  expect(sent!.text).toContain('`read`');
}, 60_000);



test('settings opens as a second page with its own navigation and return control', async () => {
  const root = await temp('settings-shell');
  const server = await consoleServer(root);

  const browser = await chromium.launch({ headless: true });
  cleanup.push(() => browser.close());
  const page = await browser.newPage();
  await page.goto(`${server.url}/#/settings`);
  await page.getByTestId('settings-shell').waitFor();
  expect(await page.locator('.settings-back').getAttribute('href')).toBe('#/');
  const nav = page.locator('.settings-nav');
  expect(await nav.innerText()).toContain('常规');
  expect(await nav.innerText()).toContain('归档对话');
  expect(await nav.innerText()).not.toContain('通用/偏好');
  expect(await nav.innerText()).not.toContain('高级设置');
  expect(await nav.innerText()).not.toContain('Git 准备');
  expect(await nav.innerText()).not.toContain('模型');
  expect(await nav.innerText()).not.toContain('项目');
  expect(await nav.innerText()).not.toContain('并发限制');
  expect(await nav.innerText()).not.toContain('连接与配置向导');
  expect(await nav.innerText()).not.toContain('凭据');
  expect(await nav.innerText()).not.toContain('模型偏好');
  expect(await page.locator('.app-shell').count()).toBe(0);

  expect(await page.getByTestId('settings-preferences').isVisible()).toBe(true);
  expect(await page.locator('.settings-project-status').count()).toBe(1);
  await page.locator('.settings-back').click();
  await page.getByTestId('app-rail').waitFor();
  expect(await page.getByTestId('rail-models').getAttribute('href')).toBe('#/models');
  await page.getByTestId('rail-models').click();
  await page.getByTestId('models-page').waitFor();
  expect(await page.locator('.tab[data-active="true"] .tab-title').innerText()).toBe('模型');
}, 60_000);
