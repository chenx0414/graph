/**
 * MCP acceptance through pi-mcp-adapter, on the production path.
 *
 * Run: node --experimental-strip-types scripts/mcp-adapter-e2e.ts
 *
 * Builds a real Graph task in a throwaway state directory whose worker definition
 * binds the pi-mcp-adapter capability plus one remote MCP server, drives it with a
 * real model, and prints the tool invocations the worker made. Success means the
 * operation called the adapter's "mcp" gateway and the MCP server answered.
 * Needs network and a configured OPENCODE_GO_API_KEY; it never touches ~/.graph.
 */
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { openTaskRuntime } from '../src/core/task-runtime.ts';
import { TaskStore, canonicalJson } from '../src/core/store.ts';

const key = (JSON.parse(await readFile(join(homedir(), 'Library/Application Support/Graph/secrets.json'), 'utf8')) as { entries: Record<string, string> }).entries.OPENCODE_GO_API_KEY!;
const root = await mkdtemp(join(tmpdir(), 'graph-mcp-prod-node-'));
const workspace = join(root, 'project');
const capabilityRoot = join(root, 'graph', 'capabilities');
await mkdir(workspace, { recursive: true });

const adapter = join(capabilityRoot, 'mcp-adapter');
const docs = join(capabilityRoot, 'cloudflare-docs');
await mkdir(adapter, { recursive: true });
await mkdir(docs, { recursive: true });
await writeFile(join(adapter, 'capability.json'), canonicalJson({
  id: 'mcp-adapter', kind: 'pi-extension', version: '2.37.0', name: 'Pi MCP Adapter',
  source: 'npm:pi-mcp-adapter@^2.37.0',
  tools: [{ name: 'mcp', description: 'Access registered MCP servers through the adapter gateway.' }],
}));
await writeFile(join(docs, 'capability.json'), canonicalJson({
  id: 'cloudflare-docs', kind: 'mcp', version: '1.0.0', name: 'Cloudflare docs',
  url: 'https://docs.mcp.cloudflare.com/mcp',
}));

const baseUrl = 'https://opencode.ai/zen/go/v1';
const headers = { 'x-opencode-session': 'graph-e2e' };
const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, allowModelNetwork: true, refreshOnCreate: false });
modelRuntime.registerProvider('opencode-go', {
  baseUrl, api: 'openai-completions', apiKey: key, headers,
  models: [{
    id: 'deepseek-v4.1-flash', name: 'deepseek-v4.1-flash', api: 'openai-completions',
    baseUrl, reasoning: true, input: ['text'], contextWindow: 200_000, maxTokens: 4096,
    cost: { input: 1_000_000, output: 2_000_000, cacheRead: 0, cacheWrite: 0 }, headers,
  }],
});

const runtime = await openTaskRuntime({
  stateDir: join(root, 'state'),
  projects: [{ id: 'p', root: workspace }],
  catalog: { capabilityRoot, recipesPath: join(root, 'graph', 'agent-combinations.json') },
  models: {
    entries: [{
      id: 'local', provider: 'opencode-go', grade: 'high', api: 'openai-completions',
      baseUrl, contextWindow: 200_000, maxTokens: 4096,
      cost: { input: 1_000_000, output: 2_000_000, cacheRead: 0, cacheWrite: 0 },
      modelId: 'deepseek-v4.1-flash', credentialId: 'opencode-go', headers,
    }],
    apiKey: key, modelRuntime,
  },
  actions: {
    check: {
      kind: 'program',
      prepare: async () => async () => ({
        outcome: 'completed' as const, output: null,
        evidence: [{ acceptanceId: 'ok', summary: 'ok', artifact: { path: join(workspace, 'ok.txt'), digest: 'a'.repeat(64) } }],
      }),
    },
  },
});

await runtime.catalog.refreshCatalog();
runtime.catalog.publishDefinition('coder', {
  recommendedGrade: 'high',
  capabilities: [{ id: 'mcp-adapter', version: '2.37.0' }, { id: 'cloudflare-docs', version: '1.0.0' }],
}, 'coder');

const { taskId } = await runtime.user.begin({ projectId: 'p', request: 'Call the MCP tool.', requestId: 'begin' });
await runtime.supervisor(taskId).propose({
  requirementVersion: 1, summary: 'Call the MCP tool',
  acceptance: [{ id: 'ok', description: 'Works', checkNode: 'check' }],
  nodes: [
    { id: 'work', kind: 'agent', action: 'work', definitionVersion: 'coder@1', model: 'local' },
    { id: 'check', kind: 'program', action: 'check', dependsOn: ['work'] },
  ],
}, 'proposal');
await runtime.user.task(taskId).accept({ proposalVersion: 1, targetBranch: 'main', requestId: 'accept' });
await runtime.host.drive();

const cache = join(root, 'graph', 'extensions', 'tmp', 'extensions', 'npm', 'f35b2129', 'node_modules');
console.log('cache zod:', existsSync(join(cache, 'zod')), 'adapter:', existsSync(join(cache, 'pi-mcp-adapter')));

// Control: load the same entry in this very process, with no session around it.
{
  const { DefaultResourceLoader, SettingsManager } = await import('@earendil-works/pi-coding-agent');
  const entry = join(cache, 'pi-mcp-adapter', 'index.ts');
  const settings = SettingsManager.inMemory({
    compaction: { enabled: false }, images: { autoResize: false },
    enableAnalytics: false, enableInstallTelemetry: false,
  });
  const instanceDir = join(root, 'state', 'instances', 'probe');
  await mkdir(instanceDir, { recursive: true });
  const loader = new DefaultResourceLoader({
    cwd: workspace, agentDir: instanceDir, settingsManager: settings,
    additionalExtensionPaths: [entry, entry],
    extensionFactories: [{ name: 'probe-inline', hidden: true, factory: () => undefined }],
    systemPrompt: 'probe',
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
  });
  try { await loader.reload(); console.log('CONTROL loaded:', loader.getExtensions().extensions.flatMap(e => [...e.tools.keys()])); }
  catch (e) { console.log('CONTROL failed:', (e as Error).message); }
}

const store = new TaskStore(join(root, 'state', 'tasks.sqlite'));
const rows = store.db.prepare(
  "SELECT kind,data FROM node_entries WHERE task_id=? AND role='tool' AND kind IN ('call','result') ORDER BY seq",
).all(taskId) as { kind: string; data: string | null }[];
const calls = rows.filter(r => r.kind === 'call' && r.data).map(r => JSON.parse(r.data!) as { toolName?: string });
console.log('tool calls:', calls.map(c => c.toolName));
console.log('result blob:', rows.filter(r => r.kind === 'result').map(r => r.data).join('\n').slice(0, 2500));

const failures = store.db.prepare("SELECT type,data FROM events WHERE task_id=? AND (type='question.opened' OR type='operation.result') ORDER BY cursor").all(taskId) as { type: string; data: string }[];
for (const f of failures) console.log('EV', f.type, f.data.slice(0, 700));

store.close();
await runtime.close();
await rm(root, { recursive: true, force: true });
