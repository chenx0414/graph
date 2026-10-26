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



test('agent markdown renders and tool activity appears before the final answer', async () => {
  const root = await temp('markdown');
  const server = await consoleServer(root);

  const browser = await chromium.launch({ headless: true });
  cleanup.push(() => browser.close());
  const page = await browser.newPage();
  await page.route('**/api/conversations/synthetic', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      id: 'synthetic',
      title: 'Markdown',
      projectId: 'alpha',
      projectRoot: root,
      workspaceProjectId: 'alpha',
      anchorTaskId: 'anchor',
      createdAt: Date.now(),
      requirementVersion: 1,
      paused: false,
      messages: [
        { id: 'answer', seq: 2, role: 'assistant', kind: 'chat', text: '## 结果\n\n- **完成**\n\n`code`\n\n| Agent | 作用 |\n| :--- | ---: |\n| coder | 实现 |\n| reviewer | 审查 |', data: null, state: 'done', operationId: 'op', turn: 1, createdAt: Date.now(), updatedAt: Date.now() },
        { id: 'tool', seq: 3, role: 'tool', kind: 'tool', text: 'read README.md', data: { toolCallId: 'tool-1' }, state: 'done', operationId: 'op', turn: 1, createdAt: Date.now(), updatedAt: Date.now() },
      ],
      messageCount: 2,
      questions: [],
      proposal: null,
      accepted: [],
      master: null,
      cost: { unknown: false, amount: 0 },
      usage: { used: 0, budget: null, unlimited: true },
      telemetry: {
        model: 'local',
        thinkingLevel: 'off',
        cacheHitRate: 0.75,
        cachedInput: 75,
        cacheInput: 100,
        contextTokens: 8_000,
        contextLimit: 32_000,
        contextPercent: 25,
      },
      tasks: [],
      cursor: 1,
    }),
  }));
  await page.goto(`${server.url}/#/conversations/synthetic`);
  await page.getByTestId('conversation').waitFor();
  await page.locator('.markdown-body h2').waitFor();
  expect(await page.getByTestId('message-assistant').innerText()).toContain('最终回答');
  expect(await page.locator('.markdown-body strong').innerText()).toBe('完成');
  expect(await page.locator('.markdown-body code').innerText()).toBe('code');
  expect(await page.locator('.markdown-body table').count()).toBe(1);
  expect(await page.locator('.markdown-body th').nth(0).innerText()).toBe('Agent');
  expect(await page.locator('.markdown-body th').nth(1).getAttribute('data-align')).toBe('right');
  expect(await page.locator('.markdown-body td').nth(2).innerText()).toBe('reviewer');
  const order = await page.locator('.conversation-thread').innerText();
  expect(order.indexOf('读取 1 项')).toBeLessThan(order.indexOf('主 Agent'));
  // A finished turn folds its thinking and tool calls behind one muted line, so the
  // answer is what the reader sees.
  const folded = page.getByTestId('collapsed-turn');
  await folded.waitFor();
  expect(await folded.getAttribute('data-open')).toBe('false');
  expect(await page.getByTestId('tool-activity-group').count()).toBe(0);
  expect(await page.getByTestId('message-assistant').innerText()).toContain('最终回答');
  expect(await page.getByTestId('telemetry-cache').innerText()).toContain('75%');
  expect(await page.getByTestId('telemetry-context').innerText()).toContain('8,000 / 32,000');
  await expect.poll(() => page.getByTestId('telemetry-model').innerText()).toContain('local');
  expect(await page.getByTestId('telemetry-thinking').innerText()).toContain('思考 off');
});



test('live tool activity groups and streamed markdown follow the transcript tail', async () => {
  const root = await temp('stream');
  const server = await consoleServer(root);

  const messages = Array.from({ length: 24 }, (_, index) => ({
    id: `history-${index}`,
    seq: index + 1,
    role: index % 2 === 0 ? 'user' : 'assistant',
    kind: 'chat',
    text: `历史消息 ${index + 1}`,
    data: null,
    state: 'done',
    operationId: null,
    turn: 1,
    createdAt: index + 1,
    updatedAt: index + 1,
  }));
  const browser = await chromium.launch({ headless: true });
  cleanup.push(() => browser.close());
  const page = await browser.newPage();
  await page.route('**/api/conversations/streaming', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      id: 'streaming',
      title: '实时流',
      projectId: 'alpha',
      projectRoot: root,
      workspaceProjectId: 'alpha',
      anchorTaskId: 'anchor',
      createdAt: Date.now(),
      requirementVersion: 1,
      paused: false,
      messages,
      messageCount: messages.length,
      questions: [],
      proposal: null,
      proposalHistory: [],
      accepted: [],
      master: {
        nodeId: 'master',
        status: 'running',
        model: 'local',
        used: 42,
        budget: null,
        unlimited: true,
        definitionVersion: 'main@1',
        cost: { unknown: false, amount: 0 },
      },
      cost: { unknown: false, amount: 0 },
      usage: { used: 42, budget: null, unlimited: true },
      telemetry: {
        model: 'local',
        thinkingLevel: 'off',
        cacheHitRate: null,
        cachedInput: 0,
        cacheInput: 0,
        contextTokens: null,
        contextLimit: null,
        contextPercent: null,
      },
      tasks: [],
      cursor: 0,
    }),
  }));
  await page.route('**/api/conversations/streaming/events/stream*', route => {
    const events = [
      { cursor: 1, type: 'message.tool', data: { operationId: 'op-live', phase: 'start', toolCallId: 'tool-live', toolName: 'read', summary: 'src/web/Conversation.tsx' } },
      { cursor: 2, type: 'message.delta', data: { operationId: 'op-live', text: '## 实时输出\n\n' } },
      { cursor: 3, type: 'message.delta', data: { operationId: 'op-live', text: '正在平滑追加内容。' } },
    ];
    return route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''),
    });
  });

  await page.goto(`${server.url}/#/conversations/streaming`);
  await page.getByTestId('streaming').waitFor();
  expect(await page.getByTestId('streaming').innerText()).toContain('思考与过程 · 生成中');
  const tools = page.getByTestId('tool-activity-group');
  await tools.waitFor();
  expect(await tools.getAttribute('data-active')).toBe('true');
  // Tool calls stay folded away by default, even while they are running.
  expect(await tools.getAttribute('data-open')).toBe('false');
  expect(await tools.innerText()).toContain('正在读取 src/web/Conversation.tsx');
  await expect.poll(() => page.locator('.markdown-body h2').last().innerText()).toBe('实时输出');
  expect(await page.getByTestId('message-list').getAttribute('data-pinned')).toBe('true');
  await expect.poll(async () => page.getByTestId('message-list').evaluate(element => {
    const thread = element as HTMLElement;
    return thread.scrollHeight - thread.scrollTop - thread.clientHeight;
  })).toBeLessThanOrEqual(4);

  await page.waitForTimeout(160);
  await page.getByTestId('message-list').evaluate(element => {
    element.scrollTop = 0;
    element.dispatchEvent(new Event('scroll', { bubbles: true }));
  });
  await page.getByTestId('jump-to-latest').waitFor();
  expect(await page.getByTestId('message-list').getAttribute('data-pinned')).toBe('false');
  await page.getByTestId('jump-to-latest').click();
  await expect.poll(() => page.getByTestId('message-list').getAttribute('data-pinned')).toBe('true');
});



test('a coarse streamed delta is revealed progressively instead of landing as one block', async () => {
  const root = await temp('coarse-stream');
  const server = await consoleServer(root);

  const browser = await chromium.launch({ headless: true });
  cleanup.push(() => browser.close());
  const page = await browser.newPage();
  await page.route('**/api/conversations/coarse-stream', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      id: 'coarse-stream',
      title: '粗粒度流',
      projectId: 'alpha',
      projectRoot: root,
      workspaceProjectId: 'alpha',
      anchorTaskId: 'anchor',
      createdAt: Date.now(),
      requirementVersion: 1,
      paused: false,
      messages: [],
      messageCount: 0,
      streams: [],
      questions: [],
      proposal: null,
      proposalHistory: [],
      accepted: [],
      master: {
        nodeId: 'master',
        status: 'running',
        model: 'local',
        used: 42,
        budget: null,
        unlimited: true,
        definitionVersion: 'main@1',
        cost: { unknown: false, amount: 0 },
      },
      cost: { unknown: false, amount: 0 },
      usage: { used: 42, budget: null, unlimited: true },
      telemetry: {
        model: 'local',
        thinkingLevel: 'off',
        cacheHitRate: null,
        cachedInput: 0,
        cacheInput: 0,
        contextTokens: null,
        contextLimit: null,
        contextPercent: null,
      },
      tasks: [],
      cursor: 0,
    }),
  }));
  const fullText = '这是一段由供应商一次返回的完整长文本。客户端仍应按稳定节奏逐段揭示，而不是让它瞬间整块出现。'.repeat(4);
  await page.route('**/api/conversations/coarse-stream/events/stream*', route => route.fulfill({
    status: 200,
    contentType: 'text/event-stream',
    body: `data: ${JSON.stringify({
      cursor: 1,
      type: 'message.delta',
      data: {
        operationId: 'op-coarse',
        entryId: 'op-coarse',
        partId: 'text',
        len: fullText.length,
        reset: true,
        text: fullText,
      },
    })}\n\n`,
  }));

  await page.goto(`${server.url}/#/conversations/coarse-stream`);
  const streaming = page.getByTestId('streaming');
  await streaming.waitFor();
  await expect.poll(async () => Number(await streaming.getAttribute('data-reveal-length'))).toBeGreaterThan(0);
  const firstLength = Number(await streaming.getAttribute('data-reveal-length'));
  expect(firstLength).toBeLessThan(fullText.length);
  await expect.poll(
    () => streaming.getAttribute('data-reveal-length').then(Number),
    { timeout: 5_000 },
  ).toBe(fullText.length);
});



test('interrupted retry streams are removed before the durable final answer', async () => {
  const root = await temp('retry-stream');
  const server = await consoleServer(root);

  const browser = await chromium.launch({ headless: true });
  cleanup.push(() => browser.close());
  const page = await browser.newPage();
  const view = {
    id: 'retry-stream',
    title: '重试流',
    projectId: 'alpha',
    projectRoot: root,
    workspaceProjectId: 'alpha',
    anchorTaskId: 'anchor',
    createdAt: Date.now(),
    requirementVersion: 1,
    paused: false,
    messages: [{
      id: 'user', seq: 1, role: 'user', kind: 'chat', text: '你好', data: null,
      state: 'delivered', operationId: 'op-old', turn: 1, createdAt: Date.now(), updatedAt: Date.now(),
    }],
    messageCount: 1,
    questions: [],
    proposal: null,
    proposalHistory: [],
    accepted: [],
    master: { nodeId: 'master', status: 'succeeded', model: 'local', used: 0, budget: null, unlimited: true, definitionVersion: 'main@1', cost: { unknown: false, amount: 0 } },
    cost: { unknown: false, amount: 0 },
    usage: { used: 0, budget: null, unlimited: true },
    telemetry: { model: 'local', thinkingLevel: 'off', cacheHitRate: null, cachedInput: 0, cacheInput: 0, contextTokens: null, contextLimit: null, contextPercent: null },
    tasks: [],
    cursor: 0,
  };
  await page.route('**/api/conversations/retry-stream', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(view),
  }));
  await page.route('**/api/conversations/retry-stream/events/stream*', route => {
    const events = [
      { cursor: 1, type: 'message.delta', data: { operationId: 'op-old', text: '旧的流式回答' } },
      { cursor: 2, type: 'message.tool', data: { operationId: 'op-old', phase: 'start', toolCallId: 'old-tool', toolName: 'read', summary: 'old.md' } },
      { cursor: 3, type: 'operation.interrupted', data: { operationId: 'op-old' } },
      { cursor: 4, type: 'message.delta', data: { operationId: 'op-final', text: '最终回答' } },
      { cursor: 5, type: 'message.created', data: { message: { id: 'final', seq: 2, role: 'assistant', kind: 'chat', text: '最终回答', data: null, state: 'done', operationId: 'op-final', turn: 2, createdAt: Date.now(), updatedAt: Date.now() } } },
      { cursor: 6, type: 'operation.result', data: { operationId: 'op-final' } },
    ];
    return route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''),
    });
  });

  await page.goto(`${server.url}/#/conversations/retry-stream`);
  const answer = page.getByTestId('message-assistant');
  // The bubble exists before its final text is applied (the same stream carries both), so reading it the
  // moment the element appears is a race — and under the full parallel gate it lost: `expected '' to
  // contain '最终回答'`. Wait for the content the test is actually about.
  await expect.poll(() => answer.innerText()).toContain('最终回答');
  expect(await page.getByTestId('streaming').count()).toBe(0);
  expect(await page.getByTestId('tool-activity-group').count()).toBe(0);
  expect(await page.getByTestId('message-assistant').count()).toBe(1);
});
