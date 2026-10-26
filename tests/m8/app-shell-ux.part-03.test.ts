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



test('the composer model control switches model and thinking as one persisted selection', async () => {
  const root = await temp('model-control');
  const server = await consoleServer(root, { models: 2 });
  const selections: { model?: string; thinkingLevel?: string }[] = [];

  const browser = await chromium.launch({ headless: true });
  cleanup.push(() => browser.close());
  const page = await browser.newPage();
  await page.route('**/api/settings', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      projects: [{ id: 'alpha', root }],
      models: [
        // Each model carries the strengths it accepts: an xai-style model tops
        // out at xhigh, so the slider must not offer a level it cannot take.
        {
          id: 'local', grade: 'high', credentialId: 'local', contextWindow: 32_000, reasoning: true,
          thinkingOptions: [
            { level: 'off', label: '关闭' }, { level: 'low', label: 'low' },
            { level: 'medium', label: 'medium' }, { level: 'xhigh', label: 'xhigh' },
          ],
        },
        { id: 'fast', grade: 'medium', credentialId: 'local', contextWindow: 16_000, reasoning: false, thinkingOptions: [] },
      ],
      definitions: [],
      capabilities: [],
    }),
  }));
  await page.route('**/api/conversations/synthetic/model', async route => {
    selections.push(JSON.parse(route.request().postData() ?? '{}') as { model?: string; thinkingLevel?: string });
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ changed: true }) });
  });
  await page.route('**/api/conversations/synthetic', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      id: 'synthetic', title: 'Model control', projectId: 'alpha', projectRoot: root,
      workspaceProjectId: 'alpha', anchorTaskId: 'anchor', createdAt: Date.now(), requirementVersion: 1, paused: false,
      messages: [], messageCount: 0, questions: [], proposal: null, accepted: [], master: null,
      cost: { unknown: false, amount: 0 }, usage: { used: 0, budget: null, unlimited: true },
      telemetry: {
        model: 'local', thinkingLevel: 'off', cacheHitRate: null, cachedInput: 0, cacheInput: 0,
        contextTokens: null, contextLimit: 32_000, contextPercent: null,
      },
      tasks: [], cursor: 1,
    }),
  }));
  await page.goto(`${server.url}/#/conversations/synthetic`);
  const control = page.getByTestId('model-control');
  await control.waitFor();
  expect(await control.evaluate(element => getComputedStyle(element).borderTopWidth)).toBe('1px');
  expect(await page.getByTestId('telemetry-model').evaluate(element => getComputedStyle(element).borderTopWidth)).toBe('0px');
  expect(await page.getByTestId('telemetry-thinking').evaluate(element => getComputedStyle(element).borderTopWidth)).toBe('0px');
  await control.click();
  await page.getByTestId('model-menu').waitFor();
  const slider = page.getByTestId('thinking-slider');
  await slider.evaluate(element => {
    const input = element as HTMLInputElement;
    input.value = '3';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
  });
  await expect.poll(() => selections.length).toBe(1);
  expect(selections[0]).toMatchObject({ model: 'local', thinkingLevel: 'xhigh' });
  expect(await page.getByTestId('toasts').innerText()).not.toContain('已切换为');
  await page.getByTestId('model-menu').waitFor();

  await page.getByTestId('model-option-fast').click();
  await expect.poll(() => selections.length).toBe(2);
  expect(selections[1]).toMatchObject({ model: 'fast', thinkingLevel: 'off' });
  await page.getByTestId('model-menu').waitFor();
  await page.getByTestId('tab-open-0').click();
  await page.getByTestId('model-menu').waitFor({ state: 'detached' });
});



test('the resource library groups reusable assets and includes graph architectures', async () => {
  const root = await temp('resources');
  const capabilityRoot = join(root, 'graph', 'capabilities');
  const skill = join(capabilityRoot, 'research');
  const mcp = join(capabilityRoot, 'jira');
  const extension = join(capabilityRoot, 'pi-mcp-extension');
  const prompt = join(capabilityRoot, 'architect');
  await Promise.all([mkdir(skill, { recursive: true }), mkdir(mcp, { recursive: true }), mkdir(extension, { recursive: true }), mkdir(prompt, { recursive: true })]);
  await writeFile(join(skill, 'SKILL.md'), '# Research\n');
  await writeFile(join(skill, 'capability.json'), JSON.stringify({ id: 'research', kind: 'skill', version: '1.0.0', name: 'Preserving Productive Tensions', description: '保留多个有效方案，避免过早收敛。' }));
  await writeFile(join(mcp, 'capability.json'), JSON.stringify({ id: 'jira', kind: 'mcp', version: '1.0.0', name: 'Jira', description: 'Jira 工单管理。', command: 'node', args: ['./server.mjs'] }));
  await writeFile(join(mcp, 'server.mjs'), 'export {};\n');
  await writeFile(join(extension, 'capability.json'), JSON.stringify({ id: 'pi-mcp-extension', kind: 'pi-extension', version: '1.0.0', name: 'Pi MCP Extension', description: '帮助 Pi 加载并调用 MCP server。', entry: './index.mjs' }));
  await writeFile(join(extension, 'index.mjs'), 'export default function () {}\n');
  await writeFile(join(prompt, 'capability.json'), JSON.stringify({ id: 'architect', kind: 'prompt', role: 'agent', version: '1.0.0', name: '架构师', description: '系统设计与技术权衡。' }));
  await writeFile(join(prompt, 'agent.md'), 'You are an architect.\n');
  await writeFile(join(root, 'graph', 'agent-combinations.json'), JSON.stringify({
    version: 1,
    combinations: [{
      id: 'code', name: 'Bob_coder', description: '组合架构身份与研究 Skill。', recommendedGrade: 'medium', review: false, tags: ['编码'],
      resources: [{ resourceId: 'architect', version: '1.0.0', role: 'identity', required: true }, { resourceId: 'research', version: '1.0.0', role: 'skill', required: true }],
    }],
  }));
  const server = await consoleServer(root, { projects: [{ id: 'alpha', root }] });

  const browser = await chromium.launch({ headless: true });
  cleanup.push(() => browser.close());
  const page = await browser.newPage();
  await page.addInitScript(() => {
    (window as Window & { __openedResourceKinds?: string[] }).__openedResourceKinds = [];
    window.graph = {
      isDesktop: true,
      pickDirectory: async () => null,
      openResource: async kind => {
        (window as Window & { __openedResourceKinds?: string[] }).__openedResourceKinds!.push(kind);
        return { opened: true, path: `/tmp/${kind}` };
      },
      saveSecret: async () => ({ stored: true, applied: true }),
      secretStatus: async () => ({}),
      relaunch: async () => ({ url: location.origin }),
    };
  });
  await page.goto(`${server.url}/#/catalog`);
  await page.getByTestId('catalog').waitFor();
  expect(await page.getByTestId('resource-nav-skills').getAttribute('data-active')).toBe('true');
  await expect.poll(() => page.getByTestId('resource-section-skills').innerText()).toContain('Preserving Productive Tensions');
  await page.getByTestId('resource-catalog-search').fill('not-a-real-resource');
  expect(await page.getByTestId('resource-section-skills').innerText()).toContain('没有匹配的能力');
  await page.getByTestId('resource-catalog-search').fill('');
  expect(await page.getByTestId('resource-section-skills').innerText()).toContain('Preserving Productive Tensions');
  await page.getByTestId('resource-open-skills').click();
  expect(await page.evaluate(() => (window as Window & { __openedResourceKinds?: string[] }).__openedResourceKinds)).toEqual(['skills']);

  await page.getByTestId('resource-nav-mcp').click();
  await page.getByTestId('resource-section-mcp').waitFor();
  await expect.poll(() => page.getByTestId('resource-section-mcp').innerText()).toContain('Jira');
  await page.getByTestId('resource-open-mcp').click();

  await page.getByTestId('resource-nav-agent-md').click();
  await page.getByTestId('resource-section-agent-md').waitFor();
  await expect.poll(() => page.getByTestId('resource-section-agent-md').innerText()).toContain('架构师');
  await page.getByTestId('resource-open-agent-md').click();
  expect(await page.evaluate(() => (window as Window & { __openedResourceKinds?: string[] }).__openedResourceKinds)).toEqual(['skills', 'mcp', 'agent-md']);

  await page.getByTestId('resource-nav-pi-extensions').click();
  await page.getByTestId('resource-section-pi-extensions').waitFor();
  await expect.poll(() => page.getByTestId('resource-section-pi-extensions').innerText()).toContain('Pi MCP Extension');

  await page.getByTestId('resource-nav-skills').click();
  await page.getByTestId('resource-section-skills').waitFor();
  await page.getByTestId('resource-entry-research').click();
  await page.getByTestId('capability-detail-research').waitFor();
  const detail = await page.getByTestId('capability-detail-research').innerText();
  expect(detail).toContain('可用');
  expect(detail).toContain(skill);
  expect(detail).toContain('能力本身不会授予任务权限');
  await page.getByTestId('resource-detail-close').click();
  await page.getByTestId('resource-detail-drawer').waitFor({ state: 'detached' });

  await page.getByTestId('resource-nav-agents').click();
  await page.getByTestId('resource-section-agents').waitFor();
  await expect.poll(() => page.getByTestId('agent-combination-code').innerText()).toContain('Bob_coder');
  await expect.poll(() => page.getByTestId('resource-section-agents').innerText()).toContain('Bob_coder');
  await expect.poll(() => page.getByTestId('agent-combination-code').innerText()).toContain('组合架构身份与研究 Skill。');
  await expect.poll(() => page.getByTestId('agent-combination-code').innerText()).toContain('Agent 配方 · medium · 编码');
  await expect.poll(() => page.getByTestId('resource-section-agents').innerText()).toContain('可编译');
  expect(await page.getByTestId('resource-section-agents').innerText()).not.toContain('coder@1');

  await page.getByTestId('resource-nav-architectures').click();
  await page.getByTestId('resource-section-architectures').waitFor();
  const architectures = await page.getByTestId('architecture-library').innerText();
  expect(architectures).toContain('主管与工人');
  expect(architectures).toContain('评估与优化');
  expect(architectures).toContain('对抗式验证');
});



test('the recipe editor searches and sorts Skills, MCP and Pi extensions by name, enabled state and recipe usage', async () => {
  const root = await temp('recipe-picker');
  const capabilityRoot = join(root, 'graph', 'capabilities');
  const skills = ['alpha-skill', 'beta-skill', 'gamma-skill'];
  await Promise.all(skills.map(async id => {
    const directory = join(capabilityRoot, 'skills', id);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'SKILL.md'), `# ${id}\n`);
    await writeFile(join(directory, 'capability.json'), JSON.stringify({
      id,
      kind: 'skill',
      version: '1.0.0',
      name: `${id.replace('-skill', '').replace(/^./, letter => letter.toUpperCase())} Skill`,
    }));
  }));
  const mcp = join(capabilityRoot, 'mcp', 'jira');
  await mkdir(mcp, { recursive: true });
  await writeFile(join(mcp, 'capability.json'), JSON.stringify({
    id: 'jira',
    kind: 'mcp',
    version: '1.0.0',
    name: 'Jira MCP',
    command: 'node',
    args: ['./server.mjs'],
  }));
  const extension = join(capabilityRoot, 'pi-extensions', 'browser');
  await mkdir(extension, { recursive: true });
  await writeFile(join(extension, 'capability.json'), JSON.stringify({
    id: 'browser',
    kind: 'pi-extension',
    version: '1.0.0',
    name: 'Browser Extension',
    entry: './index.mjs',
  }));
  await writeFile(join(extension, 'index.mjs'), 'export default function () {}\n');
  const recipesPath = join(root, 'graph', 'agent-combinations.json');
  const resource = (resourceId: string) => ({ resourceId, version: '1.0.0', role: 'skill', required: true });
  await writeFile(recipesPath, JSON.stringify({
    version: 1,
    combinations: [
      {
        id: 'worker',
        name: 'Worker',
        description: 'Current recipe.',
        recommendedGrade: 'medium',
        review: false,
        tags: ['worker'],
        resources: [resource('beta-skill')],
      },
      {
        id: 'gamma-a',
        name: 'Gamma A',
        description: 'Uses gamma.',
        recommendedGrade: 'medium',
        review: false,
        tags: [],
        resources: [resource('gamma-skill')],
      },
      {
        id: 'gamma-b',
        name: 'Gamma B',
        description: 'Uses gamma too.',
        recommendedGrade: 'medium',
        review: false,
        tags: [],
        resources: [resource('gamma-skill')],
      },
    ],
  }));
  const server = await consoleServer(root, { projects: [{ id: 'alpha', root }] });

  const browser = await chromium.launch({ headless: true });
  cleanup.push(() => browser.close());
  const page = await browser.newPage();
  await page.goto(`${server.url}/#/catalog/agents`);
  await page.getByTestId('agent-combination-worker').waitFor();
  await page.getByTestId('agent-combination-worker').getByRole('button', { name: '编辑' }).click();
  expect(await page.getByTestId('agent-recipe-description').evaluate((element: HTMLInputElement) => element.value)).toBe('Current recipe.');
  const picker = page.getByTestId('recipe-picker-skills');
  const optionLabels = () => picker.locator('[data-testid^="recipe-option-skill-"]').allTextContents();

  await expect.poll(optionLabels).toEqual([
    'Alpha Skillalpha-skill@1.0.0 · 0 个配方',
    'Beta Skillbeta-skill@1.0.0 · 1 个配方',
    'Gamma Skillgamma-skill@1.0.0 · 2 个配方',
  ]);

  await page.getByTestId('recipe-capability-sort').selectOption('enabled');
  await expect.poll(optionLabels).toEqual([
    'Beta Skillbeta-skill@1.0.0 · 1 个配方',
    'Alpha Skillalpha-skill@1.0.0 · 0 个配方',
    'Gamma Skillgamma-skill@1.0.0 · 2 个配方',
  ]);

  await page.getByTestId('recipe-capability-sort').selectOption('popular');
  await expect.poll(optionLabels).toEqual([
    'Gamma Skillgamma-skill@1.0.0 · 2 个配方',
    'Beta Skillbeta-skill@1.0.0 · 1 个配方',
    'Alpha Skillalpha-skill@1.0.0 · 0 个配方',
  ]);

  await page.getByTestId('recipe-capability-search').fill('jira');
  expect(await page.getByTestId('recipe-picker-skills').innerText()).toContain('没有匹配的能力');
  expect(await page.getByTestId('recipe-picker-mcp').innerText()).toContain('Jira MCP');
  expect(await page.getByTestId('recipe-picker-extensions').innerText()).toContain('没有匹配的能力');

  await page.getByTestId('agent-recipe-description').fill('负责实现与维护代码，并在授权范围内补充基础测试。');
  await expect.poll(async () => (await catalogView(server)).agentCombinations.find(item => item.id === 'worker')?.description)
    .toBe('负责实现与维护代码，并在授权范围内补充基础测试。');
  await expect.poll(() => page.getByTestId('agent-recipe-description-save-state').innerText())
    .toContain('已自动保存');
  await page.locator('.recipe-editor .resource-detail-head').getByRole('button', { name: '关闭' }).click();
  await page.getByTestId('resource-detail-drawer').waitFor({ state: 'detached' });
});
