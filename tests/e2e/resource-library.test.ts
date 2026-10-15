import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, expect, test } from 'vitest';
import { chromium, type Page } from 'playwright';
import { build } from 'vite';
import { launchCli } from '../helpers/cli-daemon.ts';

let webDir: string;
const cleanup: (() => Promise<void>)[] = [];
beforeAll(async () => {
  webDir = await mkdtemp(join(tmpdir(), 'graph-library-web-'));
  await build({ configFile: join(process.cwd(), 'vite.config.ts'), logLevel: 'error', build: { outDir: webDir, emptyOutDir: true } });
}, 60_000);
afterAll(() => rm(webDir, { recursive: true, force: true }));
afterEach(async () => { for (const close of cleanup.reverse()) await close(); cleanup.length = 0; });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'graph-library-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  await symlink(webDir, join(root, 'web'));
  const configPath = join(root, 'graph.config.json');
  await writeFile(configPath, JSON.stringify({ version: 1, projects: [{ id: 'p', root }] }));
  const capabilityRoot = join(root, 'graph-home', 'capabilities');
  await mkdir(capabilityRoot, { recursive: true });
  return { root, configPath, capabilityRoot };
}
async function open(root: string, configPath: string) {
  const daemon = await launchCli(root, { configPath, env: { PI_CODING_AGENT_DIR: join(root, 'pi'), GRAPH_AUDIT_READY_KEY: 'synthetic-library-key', GRAPH_AUDIT_READY_URL: 'https://library.example.test/mcp' } });
  cleanup.push(() => daemon.close());
  const browser = await chromium.launch({ headless: true });
  cleanup.push(() => browser.close());
  const page = await browser.newPage();
  await page.goto(`${daemon.url}/#/catalog/skills`);
  return { daemon, page };
}
async function controls(page: Page, section: string, counts: number[]) {
  await expect.poll(async () => (await page.getByTestId(`resource-filter-${section}`).locator('button').allTextContents()).map(text => text.replace(/\s+/g, '')))
    .toEqual(['全部', '已配置', '未配置'].map((label, index) => `${label}${counts[index]}`));
}
async function entries(page: Page, group: string, ids: string[]) {
  await expect.poll(() => page.getByTestId(group).locator('[data-testid^="resource-entry-"]').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-testid'))))
    .toEqual(ids.map(id => `resource-entry-${id}`));
}

test('the real catalog filters readable skills and configured MCPs, preserving grouping, counts and actionable guidance in both views', async () => {
  const { root, configPath, capabilityRoot } = await fixture();
  for (const id of ['audit-ready-one', 'audit-ready-two']) {
    const path = join(capabilityRoot, id);
    await mkdir(path);
    await writeFile(join(path, 'capability.json'), JSON.stringify({ id, kind: 'skill', name: id, version: '1.0.0' }));
    await writeFile(join(path, 'SKILL.md'), `---\nname: ${id}\ndescription: Ready skill.\n---\n\n# Ready\n`);
  }
  await mkdir(join(capabilityRoot, 'audit-broken'));
  await writeFile(join(capabilityRoot, 'audit-broken', 'capability.json'), '{}');
  for (const [id, ready] of [['audit-a-ready', true], ['audit-b-missing', false], ['audit-c-ready', true], ['audit-d-missing', false]] as const) {
    const path = join(capabilityRoot, id);
    await mkdir(path);
    await writeFile(join(path, 'capability.json'), JSON.stringify({ id, name: id, version: '1.0.0', kind: 'mcp', headersEnv: { authorization: ready ? 'GRAPH_AUDIT_READY_KEY' : 'GRAPH_AUDIT_MISSING_KEY' }, url: ready ? '${GRAPH_AUDIT_READY_URL}' : '${GRAPH_AUDIT_MISSING_URL}' }));
  }
  const { page } = await open(root, configPath);
  const search = page.getByTestId('resource-catalog-search');
  await search.fill('audit-ready');
  await controls(page, 'skills', [2, 2, 0]);
  await entries(page, 'resource-group-skills-configured', ['audit-ready-one', 'audit-ready-two']);
  await entries(page, 'resource-group-skills-unconfigured', []);
  await page.getByTestId('resource-filter-skills-configured').click();
  await entries(page, 'resource-group-skills-configured', ['audit-ready-one', 'audit-ready-two']);
  await page.getByTestId('resource-filter-skills-unconfigured').click();
  await entries(page, 'resource-group-skills-unconfigured', []);
  await page.getByTestId('resource-filter-skills-all').click();
  await search.fill('audit-broken');
  await controls(page, 'skills', [1, 0, 1]);
  await entries(page, 'resource-group-skills-configured', []);
  await entries(page, 'resource-group-skills-unconfigured', ['audit-broken']);
  for (const text of ['清单不可读', '修复', '重新扫描']) expect(await page.getByTestId('resource-guidance-audit-broken').innerText()).toContain(text);
  await search.fill('audit-absent');
  for (const filter of ['all', 'configured', 'unconfigured']) {
    await page.getByTestId(`resource-filter-skills-${filter}`).click();
    await controls(page, 'skills', [0, 0, 0]);
    expect(await page.locator('[data-testid^="resource-entry-audit-"]').count()).toBe(0);
    expect(await page.getByTestId('resource-section-skills').innerText()).toContain('没有匹配的能力');
  }
  await page.getByTestId('resource-nav-mcp').click();
  await search.fill('audit-');
  await page.getByTestId('resource-filter-mcp-all').click();
  await controls(page, 'mcp', [4, 2, 2]);
  await entries(page, 'resource-group-mcp-configured', ['audit-a-ready', 'audit-c-ready']);
  await entries(page, 'resource-group-mcp-unconfigured', ['audit-b-missing', 'audit-d-missing']);
  expect(await page.locator('[data-testid^="resource-entry-audit-"]').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-testid')))).toEqual(['resource-entry-audit-a-ready', 'resource-entry-audit-c-ready', 'resource-entry-audit-b-missing', 'resource-entry-audit-d-missing']);
  await search.fill('missing');
  await controls(page, 'mcp', [2, 0, 2]);
  await entries(page, 'resource-group-mcp-configured', []);
  await entries(page, 'resource-group-mcp-unconfigured', ['audit-b-missing', 'audit-d-missing']);
  await search.fill('audit-');
  await controls(page, 'mcp', [4, 2, 2]);
  for (const id of ['audit-b-missing', 'audit-d-missing']) {
    const guidance = await page.getByTestId(`resource-guidance-${id}`).innerText();
    for (const text of ['GRAPH_AUDIT_MISSING_KEY', 'GRAPH_AUDIT_MISSING_URL', '环境变量', '设置页']) expect(guidance).toContain(text);
  }
  for (const [filter, visible] of [['configured', ['audit-a-ready', 'audit-c-ready']], ['unconfigured', ['audit-b-missing', 'audit-d-missing']]] as const) {
    await page.getByTestId(`resource-filter-mcp-${filter}`).click();
    await controls(page, 'mcp', [4, 2, 2]);
    await expect.poll(() => page.locator('[data-testid^="resource-entry-audit-"]').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-testid')))).toEqual(visible.map(id => `resource-entry-${id}`));
  }
  await page.getByTestId('resource-nav-config').click();
  await page.getByTestId('resource-filter-config-all').click();
  await controls(page, 'config', [5, 2, 3]);
  const configIds = (group: string) => page.getByTestId(`capability-config-group-${group}`).locator('article').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-testid')));
  expect(await configIds('configured')).toEqual(['capability-config-audit-a-ready', 'capability-config-audit-c-ready']);
  expect(await configIds('unconfigured')).toEqual(['capability-config-audit-b-missing', 'capability-config-audit-d-missing', 'capability-config-audit-broken']);
  for (const id of ['audit-b-missing', 'audit-d-missing']) {
    const guidance = await page.getByTestId(`capability-config-guidance-${id}`).innerText();
    for (const text of ['GRAPH_AUDIT_MISSING_KEY', 'GRAPH_AUDIT_MISSING_URL', '环境变量', '设置页']) expect(guidance).toContain(text);
  }
  for (const text of ['配置读取失败', '修复', '重新扫描']) expect(await page.getByTestId('capability-config-guidance-audit-broken').innerText()).toContain(text);
  for (const [filter, ids] of [['configured', ['audit-a-ready', 'audit-c-ready']], ['unconfigured', ['audit-b-missing', 'audit-d-missing', 'audit-broken']]] as const) {
    await page.getByTestId(`resource-filter-config-${filter}`).click();
    await controls(page, 'config', [5, 2, 3]);
    await expect.poll(() => page.getByTestId('capability-config-list').locator('article').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-testid')))).toEqual(ids.map(id => `capability-config-${id}`));
  }
}, 90_000);

test('an isolated fresh catalog shows the real empty configuration state', async () => {
  const { root, configPath } = await fixture();
  const { page } = await open(root, configPath);
  await page.getByTestId('resource-nav-config').click();
  await expect.poll(() => page.getByTestId('resource-section-config').innerText()).toContain('暂无需要配置的能力');
  expect(await page.getByTestId('resource-section-config').locator('article').count()).toBe(0);
}, 60_000);
