import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { Catalog } from '../../src/catalog/catalog.ts';
import { TaskStore } from '../../src/core/store.ts';
import { fullAccessPolicy, standardAccessPolicy } from '../../src/core/access-policy.ts';
import { openAgentContextLibrary } from '../../src/runtime/agent-context.ts';
import { openAgentContextAssembly } from '../../src/runtime/agent-context-assembly.ts';
import { openGraphServer } from '../../src/server/host.ts';
import { openaiServer } from '../fixtures/openai-server.ts';

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const close of cleanup.reverse()) await close(); cleanup.length = 0; });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'graph-context-assembly-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const capabilityRoot = join(root, 'capabilities');
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  await mkdir(capabilityRoot);
  const library = openAgentContextLibrary(join(root, 'prompts'));
  await library.ensure();
  return { root, capabilityRoot, workspace, library };
}

async function capability(root: string, id: string, manifest: Record<string, unknown>, files: Record<string, string>) {
  const path = join(root, id);
  await mkdir(path);
  await writeFile(join(path, 'capability.json'), JSON.stringify({ id, name: id, version: '1.0.0', ...manifest }));
  for (const [name, content] of Object.entries(files)) await writeFile(join(path, name), content);
}

// Cross the HTTP and real Pi seams: neither side supplies a manually assembled
// expected inventory, so this catches a newly added or changed tool drifting.
test('the next-operation preview matches the real master tools and context at the definition it will run', async () => {
  const { root, capabilityRoot, workspace, library } = await fixture();
  await capability(capabilityRoot, 'identity-one', { kind: 'prompt', role: 'agent' }, { 'agent.md': 'BOUND IDENTITY ONE\n' });
  await capability(capabilityRoot, 'identity-two', { kind: 'prompt', role: 'agent' }, { 'agent.md': 'BOUND IDENTITY TWO\n' });
  await writeFile(join(workspace, 'AGENTS.md'), 'LOWER PRIORITY PROJECT INSTRUCTIONS');
  await writeFile(join(workspace, 'AGENTS.override.md'), 'SELECTED PROJECT INSTRUCTIONS');
  await writeFile(join(library.root, 'agents/guide.md'), 'EDITABLE GUIDE IDENTITY');
  await library.setDisabledTools(['read', 'write', 'artifact_retire']);
  const provider = await openaiServer([{ text: 'done' }]);
  cleanup.push(() => provider.close());
  let version = 'guide@1';
  let access = fullAccessPolicy();
  const server = await openGraphServer({
    stateDir: join(root, 'state'), agentContext: library, catalog: { capabilityRoot },
    projects: [{ id: 'project', root: workspace }], access: () => access,
    // Diagnostics and changes exist without an inventory callback; these are
    // different host facts and must not be inferred from systemSummary.
    systemContext: {},
    models: {
      entries: [{ id: 'local', provider: 'graph-openai', grade: 'high', api: 'openai-completions', baseUrl: provider.model.baseUrl, contextWindow: 32_000, maxTokens: 256 }],
      credentialFor: () => ({ credentialId: 'local', apiKey: 'scripted-local-key' }), modelRuntime: provider.runtime,
    },
    master: { action: 'master', definitionVersion: () => version, model: 'local' },
  });
  cleanup.push(() => server.close());
  server.runtime.catalog.publishDefinition('guide', { recommendedGrade: 'high', prompts: { agent: { id: 'identity-one', version: '1.0.0' } } }, 'guide-v1');
  const created = await server.runtime.conversations.create({ projectId: 'project', text: 'inspect', requestId: 'create' });
  server.runtime.catalog.publishDefinition('guide', { recommendedGrade: 'high', prompts: { agent: { id: 'identity-two', version: '1.0.0' } } }, 'guide-v2');
  version = 'guide@2';
  const home = await server.app.inject({ method: 'GET', url: '/', headers: { origin: 'http://127.0.0.1' } });
  const headers = { origin: 'http://127.0.0.1', cookie: String(home.headers['set-cookie'] ?? '') };
  const response = await server.app.inject({ method: 'GET', url: `/api/agent-context?conversationId=${created.conversationId}`, headers });
  expect(response.statusCode, response.body).toBe(200);
  const preview = response.json<Awaited<ReturnType<typeof server.runtime.agentContextPreview>>>();
  expect(preview.definitionVersion).toBe('guide@2');
  expect(preview.latestDefinitionVersion).toBe('guide@2');
  expect(preview.prompts.find(prompt => prompt.key === 'runtime/worker.md')?.content).toContain('{{retrievalNote}}');
  expect(preview.prompts.find(prompt => prompt.key === 'runtime/worker.md')?.defaultContent).toContain('{{retrievalNote}}');
  expect(preview.preview.text).toContain('BOUND IDENTITY TWO');
  expect(preview.preview.text).not.toContain('BOUND IDENTITY ONE');
  expect(preview.preview.text).not.toContain('EDITABLE GUIDE IDENTITY');
  // Project instructions are injected by the Pi session itself, so the composition
  // Graph previews does not repeat them.
  expect(preview.preview.text).not.toContain('SELECTED PROJECT INSTRUCTIONS');
  expect(preview.preview.text).not.toContain('LOWER PRIORITY');
  expect(preview.tools.filter(tool => tool.name === 'read')).toHaveLength(1);
  expect(preview.tools.find(tool => tool.name === 'read')).toMatchObject({ enabled: false, available: false });
  expect(preview.tools.find(tool => tool.name === 'artifact_publish')?.parameters).toEqual(expect.arrayContaining(['requestId', 'expectedVersion']));
  expect(preview.tools.some(tool => tool.name === 'inspect_graph_system')).toBe(true);
  expect(preview.tools.some(tool => tool.name === 'read_system_capabilities')).toBe(false);
  expect(provider.requests).toHaveLength(0);
  await server.runtime.host.runReady();
  expect(provider.requests).toHaveLength(1);
  const sent = provider.requests[0] as { tools: { function: { name: string; description: string; parameters: { properties: Record<string, unknown> } } }[]; messages: { role: string; content: string }[] };
  const actual = new Map(sent.tools.map(tool => [tool.function.name, tool.function]));
  const enabled = preview.tools.filter(tool => tool.enabled && tool.available);
  expect([...actual.keys()].sort()).toEqual(enabled.map(tool => tool.name).sort());
  for (const tool of enabled.filter(tool => tool.source === 'Graph')) {
    expect(actual.get(tool.name)?.description).toBe(tool.description);
    expect(Object.keys(actual.get(tool.name)!.parameters.properties).sort()).toEqual(tool.parameters);
  }
  const system = sent.messages.find(message => message.role === 'system' || message.role === 'developer')!.content;
  for (const section of preview.preview.sections) {
    expect(system).toContain(`<${section.id}>\n${section.parts.map(part => part.content.trim()).filter(Boolean).join('\n\n')}\n</${section.id}>`);
  }
  // Project context, the skills block and the working directory are the Pi
  // session's own additions: they reach the request, never the preview.
  expect(system).toContain('<project_context>');
  expect(system).toContain('SELECTED PROJECT INSTRUCTIONS');
  expect(system).toContain('<cwd>');
  // The preview follows next-operation settings, while the previous request is
  // unchanged. No new model call or historical load fact is needed to refresh.
  access = standardAccessPolicy();
  await library.savePrompt('rules/common.md', 'NEXT OPERATION RULE');
  const next = await server.runtime.agentContextPreview(created.conversationId);
  expect(next.preview.text).toContain('NEXT OPERATION RULE');
  expect(next.preview.text).not.toContain('Full access is active for this operation');
  expect(system).not.toContain('NEXT OPERATION RULE');
  expect(provider.requests).toHaveLength(1);
}, 120_000);

test('preview reads declarations without importing an extension or starting an MCP command', async () => {
  const { root, capabilityRoot, workspace, library } = await fixture();
  const marker = join(root, 'executed');
  const effect = `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'unexpected');`;
  await capability(capabilityRoot, 'extension', {
    kind: 'pi-extension', entry: './index.mjs', tools: [{ name: 'declared_probe', description: 'Declared probe' }],
  }, { 'index.mjs': `${effect}\nexport default function () {}` });
  await capability(capabilityRoot, 'mcp', {
    kind: 'mcp', command: 'node', args: ['./server.mjs'], networkDomains: [],
  }, { 'server.mjs': effect });
  const store = new TaskStore(join(root, 'tasks.sqlite'));
  cleanup.push(() => store.close());
  const catalog = new Catalog(store, { capabilityRoot });
  await catalog.refresh();
  catalog.publishDefinition('main', { recommendedGrade: 'high', capabilities: [{ id: 'extension', version: '1.0.0' }, { id: 'mcp', version: '1.0.0' }] });
  const assembly = await openAgentContextAssembly({ catalog, library, workspace, definitionVersion: 'main@1', action: 'master', role: 'master' });
  const preview = await assembly.preview({ role: 'master' });
  expect(preview.tools.find(tool => tool.name === 'declared_probe')).toMatchObject({ runtimeAvailable: null, enabled: true });
  // A tool reaches the model through the provider request, so the composed prompt
  // never carries a tool line - declared or otherwise.
  expect(preview.composed.text).not.toContain('declared_probe');
  expect(preview.capabilities.find(item => item.id === 'mcp')).toMatchObject({ tools: [] });
  // One capability description, in the Graph section itself: the console preview
  // is the final prompt by construction, and no second block is appended.
  expect(preview.composed.text).toContain('Use only the tools listed in the provider request.');
  expect(preview.composed.text).not.toContain('# Capability awareness');
  expect(preview.composed.text).not.toContain('## Callable tools');
  expect(preview.composed.text).not.toContain('loaded for this Agent process');
  expect(existsSync(marker)).toBe(false);
  expect(await readFile(join(capabilityRoot, 'extension/index.mjs'), 'utf8')).toContain('unexpected');
});

test('project instruction read failures are surfaced instead of silently falling back', async () => {
  const { root, workspace, capabilityRoot, library } = await fixture();
  await mkdir(join(workspace, 'AGENTS.override.md'));
  await writeFile(join(workspace, 'AGENTS.md'), 'fallback would conceal a bad override');
  const store = new TaskStore(join(root, 'tasks.sqlite'));
  cleanup.push(() => store.close());
  const catalog = new Catalog(store, { capabilityRoot });
  await expect(openAgentContextAssembly({ catalog, library, workspace, action: 'master', role: 'master' })).rejects.toThrow();
});

test('the Main Agent identity explains harness self-improvement only when RSI is available', async () => {
  const { root, workspace, capabilityRoot, library } = await fixture();
  const store = new TaskStore(join(root, 'tasks.sqlite'));
  cleanup.push(() => store.close());
  const catalog = new Catalog(store, { capabilityRoot });
  const withRsi = await openAgentContextAssembly({
    catalog, library, workspace, definitionVersion: 'main@1', action: 'master', role: 'master', fullAccess: true, rsi: true,
  });
  const rsiPreview = await withRsi.preview({
    role: 'master', run: true,
    rsi: { status: true, apply: true },
  });
  expect(rsiPreview.composed.sections.find(section => section.id === 'identity')?.parts.map(part => part.id))
    .toContain('identity.harness');
  expect(rsiPreview.tools.map(tool => tool.name)).toEqual(expect.arrayContaining(['inspect_rsi_status', 'apply_rsi_change']));

  const withoutRsi = await openAgentContextAssembly({
    catalog, library, workspace, definitionVersion: 'main@1', action: 'master', role: 'master', fullAccess: true,
  });
  const plainPreview = await withoutRsi.preview({ role: 'master', run: true });
  expect(plainPreview.composed.sections.find(section => section.id === 'identity')?.parts.map(part => part.id))
    .not.toContain('identity.harness');
  expect(plainPreview.tools.map(tool => tool.name)).not.toContain('apply_rsi_change');
});
