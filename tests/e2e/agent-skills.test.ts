import { lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { launchCli } from '../helpers/cli-daemon.ts';
import { openaiServer } from '../fixtures/openai-server.ts';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.reverse()) await close(); cleanup.length = 0; });
const frontmatter = (name: string, description: string, disabled = false) => `---\nname: ${name}\ndescription: ${description}\n${disabled ? 'disable-model-invocation: true\n' : ''}---\n\n# ${name}\n`;
async function skill(path: string, name: string, description: string, disabled = false) {
  await mkdir(path, { recursive: true });
  await writeFile(join(path, 'SKILL.md'), frontmatter(name, description, disabled));
  return path;
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'graph-e2e-agent-skills-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  const graphHome = join(root, 'graph-home');
  const capabilityRoot = join(graphHome, 'capabilities');
  const own = join(graphHome, 'agents', 'main', 'skills');
  await mkdir(project); await mkdir(join(root, 'web'));
  await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div id="root">Graph</div>');
  return { root, project, graphHome, capabilityRoot, own };
}

test('the actual catalog publishes native folder facts, project owners and grouped duplicate sources without losing identities', async () => {
  const { root, project, capabilityRoot, own } = await fixture();
  await skill(join(own, 'my-notes'), 'my-notes', 'Take notes.');
  await mkdir(join(own, 'broken'), { recursive: true });
  await writeFile(join(own, 'broken', 'SKILL.md'), '# Broken\n');
  const handoff = await skill(join(capabilityRoot, 'handoff', '1.0.0'), 'handoff', 'Compact the conversation.', true);
  await writeFile(join(handoff, 'capability.json'), JSON.stringify({ id: 'handoff', kind: 'skill', version: '1.0.0', name: 'Handoff' }));
  await symlink(handoff, join(own, 'handoff'));
  await skill(join(project, '.agents', 'skills', 'repo-skill'), 'repo-skill', 'Ships with the repo.');
  await skill(join(project, '.pi', 'skills', 'pi-skill'), 'pi-skill', 'Pi project skill.');
  for (const id of ['vendor-skills-notes', 'vendor-agents-skills-notes']) {
    const path = await skill(join(capabilityRoot, 'skills', id), 'notes', 'Take notes.');
    await writeFile(join(path, 'capability.json'), JSON.stringify({ id, kind: 'skill', version: '1.0.0', name: 'notes' }));
  }
  await skill(join(project, '.agents', 'skills', 'notes'), 'notes', 'Project notes.');
  const configPath = join(root, 'graph.config.json');
  await writeFile(configPath, JSON.stringify({ version: 1, projects: [{ id: 'demo', root: project }] }));
  const daemon = await launchCli(root, { configPath, env: { PI_CODING_AGENT_DIR: join(root, 'pi') } });
  cleanup.push(() => daemon.close());
  expect((await daemon.request('/api/catalog/refresh', { method: 'POST', body: '{}' })).status).toBe(200);
  const settings = await (await daemon.request('/api/settings')).json() as { capabilities: { id: string; kind: string; name: string; owner?: string; note?: string; status: string; version: string; error?: string; duplicates?: { id: string; source: string }[] }[] };
  const byId = new Map(settings.capabilities.map(row => [row.id, row]));
  expect(byId.get('my-notes')).toMatchObject({ kind: 'skill', version: 'local', status: 'available', owner: 'main', name: 'my-notes', description: 'Take notes.' });
  expect(byId.get('broken')).toMatchObject({ status: 'invalid', owner: 'main', version: 'local' });
  expect(byId.get('broken')?.error).toContain('frontmatter');
  expect(settings.capabilities.filter(row => row.id === 'handoff')).toHaveLength(1);
  expect(byId.get('handoff')).toMatchObject({ version: '1.0.0', status: 'available' });
  expect(byId.get('handoff')?.note).toContain('disable-model-invocation');
  expect(byId.get('repo-skill')).toMatchObject({ kind: 'skill', version: 'local', owner: '项目 demo（.agents）', status: 'available', name: 'repo-skill' });
  expect(byId.get('pi-skill')).toMatchObject({ kind: 'skill', version: 'local', owner: '项目 demo（.pi）' });
  const notes = settings.capabilities.filter(row => row.kind === 'skill' && row.name === 'notes');
  expect(notes).toHaveLength(1);
  expect(notes[0]?.id).toBe('vendor-skills-notes');
  expect(notes[0]?.duplicates).toMatchObject([{ id: 'vendor-agents-skills-notes', source: '能力库' }, { id: 'notes', source: '项目 demo（.agents）' }]);
  const raw = await (await daemon.request('/api/catalog')).json() as { capabilities: { id: string; name: string }[] };
  expect(raw.capabilities.filter(row => row.name === 'notes').map(row => row.id).sort()).toEqual(['notes', 'vendor-agents-skills-notes', 'vendor-skills-notes']);
}, 60000);

test('real main recipe changes retarget only owned skill links and update the native model prompt', async () => {
  const { root, project, capabilityRoot, own } = await fixture();
  const provider = await openaiServer([]); cleanup.push(() => provider.close());
  const v1 = await skill(join(capabilityRoot, 'bound-flow', '1.0.0'), 'bound-flow', 'Bound version one description.');
  const v2 = await skill(join(capabilityRoot, 'bound-flow', '2.0.0'), 'bound-flow', 'Bound version two description.');
  for (const [path, version] of [[v1, '1.0.0'], [v2, '2.0.0']]) await writeFile(join(path!, 'capability.json'), JSON.stringify({ id: 'bound-flow', kind: 'skill', version, name: 'bound-flow' }));
  await skill(join(own, 'my-own'), 'my-own', 'Hand written by the user.');
  await symlink(join(root, 'elsewhere'), join(own, 'external'));
  await skill(join(own, 'disabled-local'), 'disabled-local', 'DISABLED_SKILL_SENTINEL', true);
  await skill(join(root, '.agents', 'skills', 'agents-global'), 'agents-global', 'Agents global description.');
  await skill(join(root, 'pi', 'skills', 'pi-global'), 'pi-global', 'Pi global description.');
  await skill(join(project, '.agents', 'skills', 'agents-project'), 'agents-project', 'Agents project description.');
  await skill(join(project, '.pi', 'skills', 'pi-project'), 'pi-project', 'Pi project description.');
  const configPath = join(root, 'graph.config.json');
  await writeFile(configPath, JSON.stringify({ version: 1, projects: [{ id: 'p', root: project }], credentials: { local: { secretRef: 'GRAPH_LOCAL_KEY' } }, models: { entries: [{ id: 'local', provider: 'graph-local', grade: 'high', api: 'openai-completions', baseUrl: provider.model.baseUrl, contextWindow: 32000, maxTokens: 256, credentialId: 'local' }] } }));
  const daemon = await launchCli(root, { configPath, env: { PI_CODING_AGENT_DIR: join(root, 'pi'), GRAPH_LOCAL_KEY: 'skills-synthetic' }, extraArgs: ['--execute'] });
  cleanup.push(() => daemon.close());
  const bind = async (version?: string) => {
    const response = await daemon.request('/api/catalog/combinations', { method: 'POST', body: JSON.stringify({ combination: { id: 'main', name: 'Skills main', description: 'Native skills owner', mode: 'main', recommendedGrade: 'high', review: false, tags: [], resources: version ? [{ resourceId: 'bound-flow', version, role: 'skill', required: true }] : [] } }) });
    expect(response.status, await response.clone().text()).toBe(200);
    expect((await daemon.request('/api/catalog/combinations/main/compile', { method: 'POST', body: '{}' })).status).toBe(200);
  };
  const prompt = async (label: string) => {
    const response = await daemon.request('/api/conversations', { method: 'POST', body: JSON.stringify({ projectId: 'p', model: 'local', text: `Skill lifecycle ${label}`, requestId: label }) });
    expect(response.status).toBe(200);
    const matching = () => provider.requests.find(request => {
      const body = request as { tools?: unknown[]; messages?: { role: string; content: unknown }[] };
      return body.tools?.length && body.messages?.some(message => message.role === 'user' && JSON.stringify(message.content).includes(`Skill lifecycle ${label}`));
    });
    await expect.poll(matching, { timeout: 20000 }).toBeDefined();
    return JSON.stringify(matching());
  };
  await bind('1.0.0');
  const first = await prompt('version-one');
  expect((await lstat(join(own, 'bound-flow'))).isSymbolicLink()).toBe(true);
  expect(await readlink(join(own, 'bound-flow'))).toBe(v1);
  expect(first).toContain('<available_skills>');
  expect(first).toContain(`<location>${join(own, 'bound-flow', 'SKILL.md')}</location>`);
  expect(first).toContain(`<location>${join(own, 'my-own', 'SKILL.md')}</location>`);
  expect(first).toContain('Bound version one description.');
  for (const description of ['Hand written by the user.', 'Agents global description.', 'Pi global description.', 'Agents project description.', 'Pi project description.']) expect(first).toContain(description);
  expect(first).not.toContain('DISABLED_SKILL_SENTINEL');
  await bind('2.0.0');
  const second = await prompt('version-two');
  expect(await readlink(join(own, 'bound-flow'))).toBe(v2);
  expect(second).toContain('Bound version two description.');
  expect(second).not.toContain('Bound version one description.');
  await bind();
  const third = await prompt('unbound');
  await expect(lstat(join(own, 'bound-flow'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await readFile(join(own, 'my-own', 'SKILL.md'), 'utf8')).toContain('Hand written by the user.');
  expect((await lstat(join(own, 'external'))).isSymbolicLink()).toBe(true);
  expect(await readlink(join(own, 'external'))).toBe(join(root, 'elsewhere'));
  expect(third).not.toContain('Bound version');
  expect(third).toContain('Hand written by the user.');
}, 120000);

test('a native graph worker combines its own, global, bound-project and distinct working-directory skills while absent folders contribute nothing', async () => {
  for (const populated of [true, false]) {
    const { root, project, graphHome } = await fixture();
    const { realpath } = await import('node:fs/promises');
    const work = join(project, 'work'); await mkdir(work);
    const canonicalProject = await realpath(project);
    const canonicalWork = await realpath(work);
    const own = join(graphHome, 'agents', 'scope-worker', 'skills');
    const piDir = join(root, populated ? 'pi-global' : 'pi-absent');
    const expected: { name: string; description: string; path: string }[] = [
      { name: 'scope-own', description: 'Independent worker-owned instructions.', path: join(own, 'scope-own') },
      ...(populated ? [
        { name: 'scope-global-pi', description: 'Native Pi global scope.', path: join(piDir, 'skills', 'scope-global-pi') },
        { name: 'scope-global-agents', description: 'Native Agents global scope.', path: join(root, '.agents', 'skills', 'scope-global-agents') },
        { name: 'scope-project-pi', description: 'Bound project Pi scope.', path: join(canonicalProject, '.pi', 'skills', 'scope-project-pi') },
        { name: 'scope-project-agents', description: 'Bound project Agents scope.', path: join(canonicalProject, '.agents', 'skills', 'scope-project-agents') },
        { name: 'scope-cwd-pi', description: 'Working directory Pi scope.', path: join(canonicalWork, '.pi', 'skills', 'scope-cwd-pi') },
        { name: 'scope-cwd-agents', description: 'Working directory Agents scope.', path: join(canonicalWork, '.agents', 'skills', 'scope-cwd-agents') },
      ] : []),
    ];
    for (const row of expected) await skill(row.path, row.name, row.description);
    const mainPlans: Parameters<typeof openaiServer>[0] = [];
    const main = await openaiServer(mainPlans); cleanup.push(() => main.close());
    const worker = await openaiServer([{ text: 'The scoped worker has answered.' }]); cleanup.push(() => worker.close());
    const cheap = await openaiServer([{ text: 'No suggestion.' }, { text: 'No suggestion.' }]); cleanup.push(() => cheap.close());
    const configPath = join(root, 'graph.config.json');
    await writeFile(configPath, JSON.stringify({ version: 1, projects: [{ id: 'p', root: project }], credentials: { local: { secretRef: 'GRAPH_LOCAL_KEY' } }, models: { entries: [
      { id: 'main', provider: 'graph-main', grade: 'high', api: 'openai-completions', baseUrl: main.model.baseUrl, contextWindow: 32000, maxTokens: 256, credentialId: 'local' },
      { id: 'worker', provider: 'graph-worker', grade: 'medium', api: 'openai-completions', baseUrl: worker.model.baseUrl, contextWindow: 32000, maxTokens: 256, credentialId: 'local' },
      { id: 'cheap', provider: 'graph-cheap', grade: 'low', api: 'openai-completions', baseUrl: cheap.model.baseUrl, contextWindow: 32000, maxTokens: 256, credentialId: 'local' },
    ] } }));
    const daemon = await launchCli(root, { configPath, env: { PI_CODING_AGENT_DIR: piDir, GRAPH_LOCAL_KEY: 'scope-only-synthetic' }, extraArgs: ['--execute'] });
    cleanup.push(() => daemon.close());
    async function get(path: string) {
      const response = await daemon.request(path); expect(response.status, await response.clone().text()).toBe(200); return response.json();
    }
    async function post(path: string, data: Record<string, unknown>) {
      const response = await daemon.request(path, { method: 'POST', body: JSON.stringify(data) });
      expect(response.status, await response.clone().text()).toBe(200); return response.json();
    }
    await post('/api/catalog/combinations', { combination: { id: 'scope-worker', name: 'Scope worker', description: 'Exercise the real worker skill boundary', systemPrompt: 'Read the available skill scope and acknowledge the job.', recommendedGrade: 'medium', review: false, tags: [], resources: [] } });
    const compiled = await post('/api/catalog/combinations/scope-worker/compile', {});
    expect(compiled.definitionVersion).toBe('scope-worker@1');
    const createCallId = `scope-create-${populated}`;
    mainPlans.push({ tools: [{ id: createCallId, name: 'graph_create', arguments: JSON.stringify({ requestId: createCallId, definition: {
      schemaVersion: 2, name: 'Distinct skill scope graph', protocols: { job: { type: 'object' } },
      nodes: { worker: { recipe: compiled.definitionVersion, model: 'worker', task: 'Acknowledge the skill scope', workspace: { base: 'project', path: 'work' },
        inputs: { job: { protocol: 'job' } }, outputs: {}, submission: {} } },
      modules: {}, edges: {}, inputs: {}, outputs: {},
    } }) }] }, { text: 'The graph exists and awaits its first input.' });
    const created = await post('/api/conversations', { projectId: 'p', model: 'main', text: 'Create the scoped worker graph', requestId: `scope-conversation-${populated}` });
    await expect.poll(async () => (await get(`/api/conversations/${created.conversationId}`)).master.status, { timeout: 30000 }).toBe('succeeded');
    const graphs = await get('/api/tasks') as { id: string; request: string }[];
    expect(graphs).toHaveLength(1); expect(graphs[0]!.request).toBe('Distinct skill scope graph');
    const graphId = graphs[0]!.id;
    // The model receives the actual owner-generated graph identity, just as a real main would.
    const returned = main.requests.flatMap(request => (request as { messages: { role: string; tool_call_id?: string; content: unknown }[] }).messages)
      .find(message => message.role === 'tool' && message.tool_call_id === createCallId);
    expect(returned).toBeDefined();
    expect(JSON.parse(String(returned!.content))).toMatchObject({ graphId, revision: 1 });
    mainPlans.push({ tools: [{ id: `scope-send-${populated}`, name: 'graph_send', arguments: JSON.stringify({ graphId, nodeId: 'worker', input: 'job', value: { purpose: 'Observe native skill loading' } }) }] }, { text: 'The scoped worker has received its input.' });
    await post(`/api/conversations/${created.conversationId}/messages`, { text: 'Send the first job to the worker', requestId: `scope-send-user-${populated}` });
    await expect.poll(async () => (await get(`/api/tasks/${graphId}/nodes/worker/run`)).node.status, { timeout: 30000 }).toBe('succeeded');
      const workerTurns = worker.requests.filter(request => ((request as { tools?: unknown[] }).tools ?? []).length > 0);
    expect(workerTurns).toHaveLength(1);
    const recorded = await get(`/api/tasks/${graphId}/nodes/worker/run`);
    expect(recorded.environment).toMatchObject({ workspace: canonicalWork, base: 'project' });
    expect(canonicalWork).not.toBe(canonicalProject);
    const expectedNames = expected.map(row => row.name).sort();
    // Metadata and the native SDK's prompt must both describe the real complete scope.
    // Soft comparisons let the two independent missing-wiring errors report together.
    expect.soft(recorded.capabilities.filter((row: { kind: string }) => row.kind === 'skill').map((row: { name: string }) => row.name).sort()).toEqual(expectedNames);
    const sent = workerTurns[0] as { messages: { role: string; content: string | { type: string; text?: string }[] }[] };
    const system = sent.messages.filter(message => message.role === 'system' || message.role === 'developer').map(message => typeof message.content === 'string' ? message.content : message.content.filter(part => part.type === 'text').map(part => part.text ?? '').join('')).join('\n');
    const nativeBlocks = system.match(/<available_skills>\s*<skill>[\s\S]*?<\/available_skills>/g) ?? [];
    expect(nativeBlocks).toHaveLength(1);
    const native = nativeBlocks[0]!;
    expect.soft([...native.matchAll(/<name>([^<]+)<\/name>/g)].map(match => match[1]).sort()).toEqual(expectedNames);
    for (const row of expected) {
      expect.soft(native).toContain(`<name>${row.name}</name>`);
      expect.soft(native).toContain(`<description>${row.description}</description>`);
      expect.soft(native).toContain(`<location>${join(row.path, 'SKILL.md')}</location>`);
    }
    if (!populated) {
      const missing = [join(piDir, 'skills'), join(root, '.agents', 'skills'), join(project, '.pi', 'skills'), join(project, '.agents', 'skills'), join(work, '.pi', 'skills'), join(work, '.agents', 'skills')];
      for (const path of missing) await expect(lstat(path)).rejects.toMatchObject({ code: 'ENOENT' });
    }
    // Each row owns an isolated real CLI and external providers; close before starting the next row.
    await daemon.close();
  }
}, 180000);
