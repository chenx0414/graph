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



test('the chat header exposes editable Agent prompts and Main Agent tools', async () => {
  const root = await temp('agent-context');
  const promptRoot = join(root, 'graph', 'prompts');
  const server = await consoleServer(root, { projects: [{ id: 'alpha', root }] });
  const created = await createConversation(server, { text: '检查 Agent 上下文', requestId: 'agent-context-ui' });

  const browser = await chromium.launch({ headless: true });
  cleanup.push(() => browser.close());
  const page = await browser.newPage();
  await page.goto(`${server.url}/#/conversations/${created.conversationId}`);
  await page.getByTestId('agent-context-open').waitFor();
  expect(await page.getByTestId('agent-context-bar').count()).toBe(0);

  await page.getByTestId('agent-context-open').click();
  await page.getByTestId('agent-context-drawer').waitFor();
  // 面板只展示真正发出去的那一份；没发过请求的会话没有可展示的 prompt。
  await page.getByTestId('agent-context-sent').waitFor();
  const sentPanel = await page.getByTestId('agent-context-sent').innerText();
  expect(sentPanel).toContain('实际发出');
  expect(sentPanel).toContain('本次会话尚未记录到已发出的请求');
  await expect.poll(() => page.getByTestId('agent-context-meta').innerText(), { timeout: 30_000, interval: 200 }).toContain(`源码 Docs ${join(process.cwd(), 'docs', 'agent')}`);
  expect(await page.locator('[data-testid="agent-context-preview"]').count()).toBe(0);
  expect(await page.locator('[data-testid="agent-context-preview-markdown"]').count()).toBe(0);
  expect(await page.locator('[data-testid="agent-preview-section-map"]').count()).toBe(0);
  expect(
    (await page.locator('.agent-context-tabs [role="tab"]').allInnerTexts()).map(label => label.split('\n')[0]!.trim()),
  ).toEqual(['实际发出的 Prompt', '工具声明', '可编辑来源', '工具与能力']);
  // 提示词与工具声明是两个独立标签：prompt 页不再带声明块。
  expect(await page.getByTestId('agent-context-sent-tools').count()).toBe(0);

  // 组装正确性属于产生它的那一层（provider 请求）；接口只给事实：工具、能力、可编辑来源。
  const payload = await page.evaluate(async (conversationId: string) => {
    const response = await fetch(`/api/agent-context?conversationId=${conversationId}`, { credentials: 'include' });
    return await response.json() as { preview?: unknown; sent: unknown; tools: unknown[]; prompts: unknown[] };
  }, created.conversationId);
  expect(payload.sent).toBeNull();
  expect(payload.preview).toBeUndefined();
  expect(payload.tools.length).toBeGreaterThan(0);
  expect(payload.prompts.length).toBeGreaterThan(0);
  await page.getByTestId('agent-context-tab-prompts').click();
  expect(await page.getByTestId('agent-prompt-docs/INDEX.md').count()).toBe(0);
  await page.getByTestId('agent-prompt-runtime/worker.md').click();
  await page.getByTestId('agent-prompt-editor').fill('CUSTOM CONVERSATION {{fullAccessInstruction}}');
  await page.getByRole('button', { name: '保存 Prompt' }).click();
  await expect.poll(() => libraryPrompt(promptRoot, 'runtime/worker.md')).toContain('CUSTOM CONVERSATION');
  await page.getByRole('button', { name: '恢复默认' }).click();
  await page.getByTestId('toasts').getByText(/已恢复 Worker 运行规则/).waitFor();
  await expect.poll(() => libraryPrompt(promptRoot, 'runtime/worker.md')).not.toContain('CUSTOM CONVERSATION');
  await page.getByTestId('agent-prompt-editor').fill('');
  await expect.poll(() => page.getByTestId('agent-prompt-editor').evaluate((element: HTMLInputElement) => element.value), { timeout: 30_000, interval: 200 }).toBe('');
  await page.getByRole('button', { name: '设为默认' }).click();
  await page.getByTestId('toasts').getByText(/已将 Worker 运行规则 设为默认/).waitFor();
  await expect.poll(() => libraryPrompt(promptRoot, 'runtime/worker.md')).toBe('');
  expect(await readFile(join(root, 'graph', 'prompts', 'defaults', 'runtime', 'worker.md'), 'utf8')).toBe('\n');
  await page.getByTestId('agent-prompt-editor').fill('Temporary after default');
  await expect.poll(() => page.getByTestId('agent-prompt-editor').evaluate((element: HTMLInputElement) => element.value), { timeout: 30_000, interval: 200 }).toBe('Temporary after default');
  await page.getByRole('button', { name: '保存 Prompt' }).click();
  await page.getByTestId('toasts').getByText(/已保存 Worker 运行规则/).waitFor();
  await expect.poll(() => libraryPrompt(promptRoot, 'runtime/worker.md')).toContain('Temporary after default');
  await page.getByRole('button', { name: '恢复默认' }).click();
  await page.getByTestId('toasts').getByText(/已恢复 Worker 运行规则/).last().waitFor();
  await expect.poll(() => libraryPrompt(promptRoot, 'runtime/worker.md')).toBe('');
  await page.getByRole('button', { name: '恢复内置' }).click();
  await page.getByTestId('toasts').getByText(/已恢复 Worker 运行规则 的内置默认/).waitFor();
  await expect.poll(() => libraryPrompt(promptRoot, 'runtime/worker.md')).toContain('Use the native Pi tools');

  await page.getByTestId('agent-context-tab-tools').click();
  // 每个标签只显示自己那一块：工具页不再把 prompt 与工具声明挤在上面。
  expect(await page.getByTestId('agent-context-sent').count()).toBe(0);
  await page.getByTestId('agent-tool-write').uncheck();
  await page.getByRole('button', { name: '保存工具选择' }).click();
  await expect.poll(async () => await libraryDisabledTools(promptRoot)).toContain('write');
}, 60_000);



test('the sent tab shows the tool declarations one request carried, with their count and size', async () => {
  const root = await temp('agent-context-tools-ui');
  const server = await consoleServer(root, { projects: [{ id: 'alpha', root }] });
  const created = await createConversation(server, { text: '看声明', requestId: 'sent-tools-ui' });

  const browser = await chromium.launch({ headless: true });
  cleanup.push(() => browser.close());
  const page = await browser.newPage();
  const declarations = [{
    name: 'propose_graph', description: 'Draft a graph',
    parameters: { type: 'object', properties: { proposalJson: { type: 'string' } }, required: ['proposalJson'] },
  }];
  const recorded = JSON.stringify(declarations);
  // The page renders the fact the API reports for one real request; the check that this
  // fact equals what went over the wire lives in the runtime test.
  await page.route('**/api/agent-context*', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      docsRoot: join(process.cwd(), 'docs', 'agent'),
      definitionVersion: 'main@1', latestDefinitionVersion: 'main@1',
      prompts: [], disabledTools: [], tools: [], capabilities: [],
      sent: { operationId: 'op-1', at: 1, text: '<identity>demo</identity>', tools: recorded },
    }),
  }));

  await page.goto(`${server.url}/#/conversations/${created.conversationId}`);
  await page.getByTestId('agent-context-open').waitFor();
  await page.getByTestId('agent-context-open').click();
  // 声明在它自己的标签页里，和 prompt 互不挤占。
  await page.getByTestId('agent-context-tab-declarations').click();
  await page.getByTestId('agent-context-sent-tools').waitFor();
  const block = await page.getByTestId('agent-context-sent-tools').innerText();
  expect(block).toContain('1 个工具');
  expect(block).toContain(`${recorded.length.toLocaleString()} 字符`);
  expect(await page.getByTestId('agent-context-sent-tools-text').innerText()).toContain('propose_graph');
  expect(await page.getByTestId('agent-context-sent-text').count()).toBe(0);
  // 回到 prompt 页：同一请求的提示词原样还在，声明块不在。
  await page.getByTestId('agent-context-tab-sent').click();
  expect(await page.getByTestId('agent-context-sent-text').innerText()).toBe('<identity>demo</identity>');
  expect(await page.getByTestId('agent-context-sent-tools').count()).toBe(0);
}, 60_000);



test('draft markdown follows preferences and image attachments survive sending and reload', async () => {
  const root = await temp('draft-image');
  const server = await consoleServer(root, { projects: [{ id: 'alpha', root }] });
  const created = await createConversation(server, { projectId: 'alpha', text: '图片测试', requestId: 'draft-image' });
  const browser = await chromium.launch({ headless: true });
  cleanup.push(() => browser.close());
  const page = await browser.newPage();
  let refreshes = 0;
  await page.route('**/api/usage/refresh', async route => { refreshes++; await route.fulfill({ json: {} }); });
  await page.clock.install();
  await page.goto(`${server.url}/#/conversations/${created.conversationId}`);
  await expect.poll(() => refreshes).toBe(1);
  const input = page.getByTestId('chat-input');
  await input.fill('**实时草稿**');
  await page.locator('.markdown-input .md-strong').waitFor();
  expect(await page.getByTestId('composer-markdown-preview').count()).toBe(0);
  await page.evaluate(() => { localStorage.setItem('graph-pref-markdown-rendering', 'false'); window.dispatchEvent(new Event('graph:preferences-changed')); });
  await page.locator('.markdown-input .md-strong').waitFor({ state: 'detached' });
  expect(await input.evaluate((element: HTMLInputElement) => element.value)).toBe('**实时草稿**');
  await page.clock.fastForward(5 * 60_000);
  await expect.poll(() => refreshes).toBe(2);
  const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nT8AAAAASUVORK5CYII=', 'base64');
  await page.getByTestId('chat-attachment-input').setInputFiles({ name: 'pixel.png', mimeType: 'image/png', buffer: bytes });
  await expect.poll(() => page.locator('.composer-attachment-preview').evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(1);
  await page.getByTestId('chat-send').click();
  const image = page.locator('.message-attachment-image').last();
  await expect.poll(() => image.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(1);
  await page.reload();
  await expect.poll(() => image.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(1);
  const src = await image.getAttribute('src');
  expect(src).toMatch(/^\/api\/messages\//);
  const response = await page.request.get(`${server.url}${src}`);
  expect(response.headers()['content-type']).toContain('image/png');
  expect(await response.body()).toEqual(bytes);
  expect((await page.request.get(`${server.url}${src?.replace(/0$/, '99')}`)).status()).toBe(400);
});



test('live Markdown edits one source, reveals syntax at the caret and preserves undo and composition', async () => {
  const root = await temp('live-markdown');
  const server = await consoleServer(root);
  const created=await createConversation(server, {text:'Live editor',requestId:'live'});
  const browser=await chromium.launch({headless:true}); cleanup.push(()=>browser.close());
  const page=await browser.newPage();
  await page.goto(`${server.url}/#/conversations/${created.conversationId}`);
  const input=page.getByTestId('chat-input');
  await input.fill('# 标题\n\n**粗体**与 `代码`\n\n最后一行');
  await input.press('End');
  await page.locator('.md-heading').waitFor();
  await expect.poll(()=>page.locator('.md-heading').innerText()).toBe('标题');
  await page.locator('.md-strong').click();
  await expect.poll(()=>page.locator('.md-strong').innerText()).toBe('**粗体**');
  await input.fill('草稿');
  await input.press('End');
  await input.press('Shift+Enter');
  await input.pressSequentially('next');
  await expect.poll(()=>input.evaluate((e:HTMLTextAreaElement)=>e.value)).toContain('\nnext');
  await input.press('ControlOrMeta+z');
  await expect.poll(()=>input.evaluate((e:HTMLTextAreaElement)=>e.value)).not.toContain('\nnext');
  await input.dispatchEvent('keydown',{key:'Enter',code:'Enter',isComposing:true});
  expect((await conversationView(server, created.conversationId)).messages.filter(m=>m.role==='user').length).toBe(1);
  await page.screenshot({path:'/tmp/graph-live-editor.png'});
  await page.goto(`${server.url}/#/catalog/architectures`);
  await page.getByTestId('architecture-canvas').waitFor();
  await page.getByRole('button',{name:/主管与工人/}).click();
  await expect.poll(()=>page.locator('.architecture-canvas .react-flow__node').count()).toBe(3);
  await page.locator('.architecture-canvas .react-flow__node').filter({hasText:'工人 A'}).click();
  await expect.poll(()=>page.locator('.architecture-stage footer').innerText()).toContain('工作副本');
  await page.screenshot({path:'/tmp/graph-architecture-board.png'});
});
