import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, expect, test } from 'vitest';
import { build } from 'vite';
import { chromium } from 'playwright';
import { launchCli } from '../helpers/cli-daemon.ts';
import { openaiServer } from '../fixtures/openai-server.ts';

/**
 * Bound capability-library skills reach the slash menu.
 *
 * The 56 pstack skills ship in the checkout but a skill only exists for the
 * console once it is a capability-library entry (`capability.json` + `SKILL.md`
 * under `<graph home>/capabilities/skills/`) and the main definition binds it.
 * This proves the whole path on a real daemon and the built console: install the
 * library entries, bind them into the `main` combination, compile it (the
 * definition version moves), and read the slash menu the person actually sees.
 *
 * The source of truth is the committed pstack lock, so the test installs the
 * same 56 entries a host installs, not a hand-written sample.
 */

interface LockSkill { name: string; path: string }
interface Lock { repository: string; commit: string; license: string; skills: LockSkill[] }

let webDir = '';
const cleanup: (() => Promise<void> | void)[] = [];

beforeAll(async () => {
  webDir = await mkdtemp(join(tmpdir(), 'graph-pstack-skills-web-'));
  await build({ configFile: join(process.cwd(), 'vite.config.ts'), logLevel: 'error', build: { outDir: webDir, emptyOutDir: true } });
}, 120_000);

afterEach(async () => { for (const close of cleanup.reverse()) await close(); cleanup.length = 0; });
afterAll(async () => { await rm(webDir, { recursive: true, force: true }); });

/** One library record per skill, exactly the shape the host installer writes. */
async function installLibrarySkills(graphHome: string, lock: Lock): Promise<{ id: string; version: string }[]> {
  const installed: { id: string; version: string }[] = [];
  const importedAt = new Date().toISOString();
  for (const entry of lock.skills) {
    const source = join(process.cwd(), '.agents', 'skills', entry.name);
    const body = await readFile(join(source, 'SKILL.md'));
    const version = createHash('sha256').update(body).digest('hex').slice(0, 12);
    const id = `pstack-skills-${entry.name}`;
    const destination = join(graphHome, 'capabilities', 'skills', id);
    await cp(source, destination, { recursive: true });
    const skill = /^---\r?\n([\s\S]*?)\r?\n---/.exec(body.toString('utf8'))?.[1] ?? '';
    const field = (key: string) => {
      const line = skill.split('\n').find(candidate => candidate.startsWith(`${key}:`));
      return (line?.slice(key.length + 1).trim() ?? '').replace(/^"(.*)"$/, '$1');
    };
    await writeFile(join(destination, 'capability.json'), `${JSON.stringify({
      id, kind: 'skill', version, name: field('name') || entry.name, description: field('description'),
      source: `${lock.repository}/tree/${lock.commit}/${entry.path}`,
      sourceRepository: lock.repository.replace('https://github.com/', ''),
      sourcePath: entry.path, resolvedCommit: lock.commit, license: lock.license,
      tags: ['imported'], importedAt,
    }, null, 2)}\n`);
    installed.push({ id, version });
  }
  return installed;
}

test('a pstack skill bound to the main definition is offered in the slash menu beside the built-in commands', async () => {
  const lock = JSON.parse(await readFile(join(process.cwd(), '.agents', 'pstack-skills-lock.json'), 'utf8')) as Lock;
  const root = await mkdtemp(join(tmpdir(), 'graph-pstack-skills-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  const graphHome = join(root, 'graph-home');
  await mkdir(project, { recursive: true });
  await mkdir(join(root, 'web'), { recursive: true });
  await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div id="root">Graph</div>');
  const installed = await installLibrarySkills(graphHome, lock);
  await writeFile(join(graphHome, 'agent-combinations.json'), `${JSON.stringify({
    version: 1,
    combinations: [{
      id: 'main', name: 'Main', description: 'The main agent with the pstack skills.',
      mode: 'main', recommendedGrade: 'high', review: false, tags: [],
      resources: installed.map(entry => ({ resourceId: entry.id, version: entry.version, role: 'skill', required: true })),
    }],
  }, null, 2)}\n`);
  const provider = await openaiServer([{ text: 'Noted.' }]);
  cleanup.push(() => provider.close());
  const configPath = join(root, 'graph.config.json');
  await writeFile(configPath, `${JSON.stringify({
    version: 1,
    projects: [{ id: 'p', root: project }],
    credentials: { local: { secretRef: 'GRAPH_PSTACK_SKILLS_KEY' } },
    models: { entries: [{ id: 'main', modelId: 'main', provider: 'graph-main', grade: 'high', api: 'openai-completions',
      baseUrl: provider.model.baseUrl, contextWindow: 32000, maxTokens: 256, credentialId: 'local' }] },
  }, null, 2)}\n`);
  const daemon = await launchCli(root, {
    configPath, graphHome, webDir,
    env: { GRAPH_PSTACK_SKILLS_KEY: 'synthetic-only' },
    extraArgs: ['--execute'],
  });
  cleanup.push(() => daemon.close());

  // Binding is the compile: the definition moves to its first version and the
  // slash menu's own data source lists every bound skill.
  const compiled = await daemon.request('/api/catalog/combinations/main/compile', { method: 'POST' });
  expect(compiled.status, await compiled.clone().text()).toBe(200);
  const definition = await compiled.json() as { definitionId: string; version: number };
  expect(definition).toMatchObject({ definitionId: 'main', version: 1 });
  const context = await (await daemon.request('/api/agent-context')).json() as {
    definitionVersion?: string;
    capabilities?: { id: string; kind: string; name: string; version: string }[];
  };
  expect(context.definitionVersion).toBe('main@1');
  const skills = (context.capabilities ?? []).filter(capability => capability.id.startsWith('pstack-skills-'));
  expect(skills).toHaveLength(56);
  expect(new Set(skills.map(skill => skill.version))).toEqual(new Set(installed.map(entry => entry.version)));

  // The same binding is what keeps the model context flat: 55 of the 56 skills
  // declare disable-model-invocation, so the turn's own system prompt names only
  // the one that does not, and the tools still reach the model by name.
  const created = await daemon.request('/api/conversations', {
    method: 'POST', body: JSON.stringify({ projectId: 'p', model: 'main', text: 'Say hello.', requestId: 'pstack-skills-turn' }),
  });
  expect(created.status, await created.clone().text()).toBe(200);
  const { conversationId } = await created.json() as { conversationId: string };
  await expect.poll(async () => {
    const view = await (await daemon.request(`/api/conversations/${conversationId}`)).json() as { master?: { status?: string } };
    return view.master?.status;
  }, { timeout: 60_000 }).toBe('succeeded');
  const request = (provider.requests[0] ?? {}) as { messages?: { role: string; content: unknown }[]; tools?: unknown[] };
  expect(request.tools?.length ?? 0).toBeGreaterThan(0);
  const system = JSON.stringify((request.messages ?? []).filter(message => message.role === 'system' || message.role === 'developer'));
  expect(system).toContain('<available_skills>');
  expect(system).toContain('<name>setup-pstack</name>');
  expect(system).not.toContain('<name>architect</name>');
  expect(system).not.toContain('<name>blast-radius</name>');

  const browser = await chromium.launch({ headless: true });
  cleanup.push(() => browser.close());
  const page = await browser.newPage();
  await page.request.get(daemon.url);
  await page.goto(daemon.url);
  await page.locator('[data-testid="conversations"]').waitFor();
  await page.getByTestId('new-conversation-input').fill('/');
  const menu = page.getByTestId('slash-popover');
  await menu.waitFor();

  // The bound skills are one group of the same menu the built-in commands use.
  // The menu opens with the composer's first keystroke; the capabilities arrive
  // from /api/agent-context, so wait for the full set before reading the group.
  await expect.poll(() => page.locator('[data-testid^="slash-skill-"]').count(), { timeout: 15_000 }).toBe(56);
  const text = await menu.innerText();
  expect(text).toContain('技能');
  for (const name of ['architect', 'setup-pstack', 'why']) expect(text).toContain(name);
  // The system entries are still there; the new group did not replace them.
  expect(await page.getByTestId('slash-system-model').count()).toBe(1);
  await page.screenshot({ path: '/tmp/graph-pstack-skills-slash.png' });
}, 300_000);
