/**
 * OpenCode GO (deepseek-v4-flash) verification probe.
 * 1) direct OpenAI-compatible call with the gateway-required x-opencode-session
 * 2) Graph's own /api/config/test against the repository config
 * 3) a real agent dispatch through a daemon on a temp project
 * The API key is read from ~/.config/opencode/opencode.json and never printed.
 * Run: export PATH="$PWD/node_modules/.bin:$PATH"; node docs/planning/acceptance-evidence/opencode-go-verification.mts
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startGraphDaemon } from '../../../src/server/start.ts';

const repo = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const opencode = JSON.parse(await readFile(join(process.env.HOME ?? '', '.config/opencode/opencode.json'), 'utf8')) as {
  provider: { 'opencode-go': { options: { apiKey: string; baseURL: string } } };
};
const provider = opencode.provider['opencode-go'];
const base = provider.options.baseURL.replace(/\/$/, '');
const headers = { authorization: `Bearer ${provider.options.apiKey}`, 'content-type': 'application/json', 'user-agent': 'graph-console/0.1', 'x-opencode-session': 'graph-console-verification' };
const evidence: Record<string, unknown> = {};

// 1) direct provider call
{
  const started = Date.now();
  const response = await fetch(`${base}/chat/completions`, {
    method: 'POST', headers,
    body: JSON.stringify({ model: 'deepseek-v4-flash', messages: [{ role: 'user', content: 'Reply with the single word: ok' }], max_tokens: 64 }),
  });
  const body = await response.json() as { choices?: { message?: { content?: string } }[]; usage?: unknown };
  evidence.direct = { status: response.status, latencyMs: Date.now() - started, reply: body.choices?.[0]?.message?.content ?? null, usage: body.usage ?? null };
}

const root = await mkdtemp(join(tmpdir(), 'graph-opencode-go-'));
const key = provider.options.apiKey;

// 2) Graph connectivity test against the repository config
{
  const daemon = await startGraphDaemon({
    configPath: join(repo, 'graph.config.json'), stateDir: join(root, 'repo-state'), webDir: join(repo, 'dist/web'),
    port: 0, mode: 'execute', env: { ...process.env, OPENCODE_GO_API_KEY: key }, log: () => undefined,
  });
  try {
    const home = await fetch(daemon.url);
    const cookie = home.headers.get('set-cookie') ?? '';
    await home.body?.cancel();
    const response = await fetch(`${daemon.url}/api/config/test`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: daemon.url, cookie },
      body: JSON.stringify({ modelId: 'deepseek-v4-flash' }),
    });
    evidence.configTest = { httpStatus: response.status, result: await response.json() };
  } finally {
    await daemon.close();
  }
}

// 3) real dispatch on a throwaway project
{
  const project = join(root, 'project');
  const webDir = join(root, 'web');
  await mkdir(project, { recursive: true });
  await mkdir(webDir, { recursive: true });
  await writeFile(join(webDir, 'index.html'), '<!doctype html><div id="root"></div>');
  const configPath = join(root, 'graph.config.json');
  await writeFile(configPath, JSON.stringify({
    version: 1,
    projects: [{ id: 'p', root: project }],
    models: { entries: [{
      id: 'deepseek-v4-flash', provider: 'opencode-go', grade: 'highest', api: 'openai-completions',
      baseUrl: base, contextWindow: 131072, maxTokens: 8192, credentialId: 'opencode-go',
      headers: { 'x-opencode-session': 'graph-console-verification' },
    }] },
    credentials: { 'opencode-go': { secretRef: 'OPENCODE_GO_API_KEY' } },
    limits: { credentials: { 'opencode-go': 2 }, sharedGroups: {} },
  }, null, 2));
  const daemon = await startGraphDaemon({
    configPath, stateDir: join(root, 'state'), webDir, port: 0, mode: 'execute',
    env: { ...process.env, OPENCODE_GO_API_KEY: key }, log: () => undefined,
  });
  try {
    const { taskId } = await daemon.server.runtime.user.begin({ projectId: 'p', request: '创建一个文件 hello.txt，内容为 hello', requestId: 'begin' });
    await daemon.server.runtime.supervisor(taskId).propose({
      requirementVersion: 1, summary: '写入 hello.txt',
      acceptance: [{ id: 'works', description: '文件存在', checkNode: 'check' }],
      nodes: [
        { id: 'work', kind: 'agent', action: 'work', definitionVersion: 'coder@1', model: 'deepseek-v4-flash' },
        { id: 'check', kind: 'program', action: 'graph.command', dependsOn: ['work'], input: { command: 'node', args: ['-e', "require('fs').accessSync('hello.txt')"] } },
      ],
    }, 'proposal');
    await daemon.server.runtime.user.task(taskId).accept({ proposalVersion: 1, targetBranch: 'main', requestId: 'accept' });
    const started = Date.now();
    for (let attempt = 0; attempt < 120; attempt += 1) {
      await daemon.server.runtime.host.runReady();
      const view = await daemon.server.runtime.user.task(taskId).view();
      const node = view.nodes.find(candidate => candidate.id === 'work');
      if (node && ['succeeded', 'failed', 'blocked'].includes(node.status)) break;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    const view = await daemon.server.runtime.user.task(taskId).view();
    evidence.dispatch = {
      elapsedMs: Date.now() - started,
      phase: view.phase,
      work: view.nodes.find(node => node.id === 'work')?.status,
      usage: view.nodes.find(node => node.id === 'work')?.used ?? null,
      questions: view.questions.map(question => question.kind),
      hello: await readFile(join(project, 'hello.txt'), 'utf8').catch(() => null),
    };
  } finally {
    await daemon.close();
  }
}

await rm(root, { recursive: true, force: true });
console.log(JSON.stringify(evidence, null, 1));
