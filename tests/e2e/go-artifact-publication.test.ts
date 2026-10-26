import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { launchCli } from '../helpers/cli-daemon.ts';

/**
 * A published artifact is an immutable version, and only a real file may
 * become one.
 *
 * Publishing is not saving a file: every publication adds a version to a
 * document, and the earlier versions stay exactly as they were. A publication
 * that names the version it expects to replace is refused when the head moved
 * on - that is how two Agents publishing the same document do not silently
 * overwrite each other. The same request id published twice is the same
 * publication, not two.
 *
 * The other half is what may be published at all: a path that leaves the
 * work copy, or a link that points out of it, is refused - and the bytes
 * behind it never reach the model.
 *
 * The proof is a real daemon and the real publication tool: the master Agent
 * publishes through its own artifact tools.
 */

interface ToolCall { id?: string; type?: string; function?: { name?: string; arguments?: string } }
interface ChatMessage { role?: string; content?: unknown; tool_call_id?: string; tool_calls?: ToolCall[] }
interface ChatBody { tools?: { function?: { name?: string } }[]; messages?: ChatMessage[] }

interface MasterCall {
  id: string;
  name: string;
  args: unknown;
  /** The host-side work this call depends on, done before the call goes out. */
  before?: () => Promise<void>;
}

/**
 * The master Agent. It plays the plan in order and records what every tool
 * call answered, so the test reads the artifacts the way the model read them.
 */
async function masterProvider(plan: () => MasterCall[], onResult?: (id: string, content: string) => void) {
  const results = new Map<string, string>();
  const failures: string[] = [];
  const requests: ChatBody[] = [];
  const server: Server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString()) as ChatBody;
    requests.push(body);
    for (const message of body.messages ?? []) {
      if (message.role !== 'tool') continue;
      const content = typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? '');
      results.set(message.tool_call_id ?? '', content);
      onResult?.(message.tool_call_id ?? '', content);
    }
    const spoken = new Set((body.messages ?? []).flatMap(message => (message.tool_calls ?? []).map(call => call.id ?? '')));
    const frame = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    if (!(body.tools ?? []).length) {
      response.write(frame({ id: 'r', choices: [{ index: 0, delta: { role: 'assistant', content: 'Noted.' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 5 } }));
      response.end('data: [DONE]\n\n');
      return;
    }
    const next = plan().find(call => !spoken.has(call.id));
    if (!next) {
      response.write(frame({ id: 'r', choices: [{ index: 0, delta: { role: 'assistant', content: 'The artifacts are as expected.' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 5 } }));
      response.end('data: [DONE]\n\n');
      return;
    }
    try {
      await next.before?.();
    } catch (error) {
      // A broken step ends the turn: the test reads the reason instead of
      // waiting for a plan that can no longer run.
      failures.push(error instanceof Error ? error.message : String(error));
      response.write(frame({ id: 'r', choices: [{ index: 0, delta: { role: 'assistant', content: 'Stopped.' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 5 } }));
      response.end('data: [DONE]\n\n');
      return;
    }
    response.write(frame({ id: 'r', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: next.id, type: 'function',
      function: { name: next.name, arguments: JSON.stringify(next.args) } }] }, finish_reason: null }] }));
    response.write(frame({ id: 'r', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
    response.end('data: [DONE]\n\n');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  return {
    results,
    failures,
    requests,
    baseUrl: `http://127.0.0.1:${port}/v1`,
    close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); },
  };
}

test('a published artifact keeps every version, refuses a stale compare-and-swap and publishes the same request only once', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-e2e-go-artifact-publication-'));
  const project = join(root, 'project');
  await mkdir(project, { recursive: true });
  await mkdir(join(root, 'web'), { recursive: true });
  await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div id="root">Graph</div>');

  const first = {
    namespace: 'research', name: 'note', content: '{"note":"NATIVE_VERSION_ONE"}', schema: 'source-list@1',
    tags: ['编码', 'Known-Issue'], title: '中文标签', expectedVersion: 0, requestId: 'first',
  };
  const artifacts: string[] = [];
  const master = await masterProvider(() => [
    { id: 'publish-bad-schema', name: 'artifact_publish', args: { ...first, schema: 'source-list/v1', requestId: 'bad-schema' } },
    { id: 'publish-bad-tag', name: 'artifact_publish', args: { ...first, tags: ['bad tag'], requestId: 'bad-tag' } },
    { id: 'publish-bad-name', name: 'artifact_publish', args: { ...first, name: '中文名', requestId: 'bad-name' } },
    { id: 'publish-first', name: 'artifact_publish', args: first },
    { id: 'publish-replay', name: 'artifact_publish', args: first },
    { id: 'publish-second', name: 'artifact_publish', args: { ...first, content: '{"note":"NATIVE_VERSION_TWO"}', expectedVersion: 1, requestId: 'second' } },
    { id: 'publish-stale', name: 'artifact_publish', args: { ...first, content: 'STALE_MUST_NOT_PUBLISH', expectedVersion: 1, requestId: 'stale' } },
    { id: 'list', name: 'artifact_list', args: { namespace: 'research' } },
    { id: 'read-one', name: 'artifact_read', args: { artifactId: artifacts[0] ?? '', version: 1 } },
    { id: 'read-two', name: 'artifact_read', args: { artifactId: artifacts[0] ?? '', version: 2 } },
  ], (id, content) => {
    // The document's id is known as soon as the first publication landed.
    if (id !== 'publish-first') return;
    const found = /"artifactId"\s*:\s*"([^"]+)"/.exec(content);
    if (found) artifacts.push(found[1]!);
  });
  let daemon: Awaited<ReturnType<typeof launchCli>> | undefined;

  const request = async (path: string, init: RequestInit = {}) => {
    const response = await daemon!.request(path, init);
    return { status: response.status, body: await response.json().catch(() => ({})) as unknown };
  };

  try {
    const configPath = join(root, 'graph.config.json');
    const entry = { api: 'openai-completions', grade: 'medium', maxTokens: 256, credentialId: 'artifacts' };
    await writeFile(configPath, JSON.stringify({
      version: 1,
      projects: [{ id: 'p', root: project }],
      credentials: { artifacts: { secretRef: 'GRAPH_ARTIFACTS_KEY' } },
      models: { entries: [
        { ...entry, id: 'main', provider: 'graph-master', modelId: 'main-model', grade: 'high', baseUrl: master.baseUrl, contextWindow: 32000 },
      ] },
    }));
    daemon = await launchCli(root, { configPath, env: { GRAPH_ARTIFACTS_KEY: 'artifacts-synthetic' }, extraArgs: ['--execute'] });

    const started = await request('/api/conversations', {
      method: 'POST', body: JSON.stringify({ projectId: 'p', model: 'main', text: 'Publish the note.', requestId: 'graph-artifacts' }),
    });
    expect(started.status, JSON.stringify(started.body)).toBe(200);

    await expect.poll(() => master.results.has('read-two'), { timeout: 180_000, interval: 250 }).toBeTruthy();
    expect(master.failures, JSON.stringify(master.failures)).toEqual([]);

    // The three bad publications are refused, each with its own reason.
    expect(master.results.get('publish-bad-schema')).toContain('schema must use kind@version syntax');
    expect(master.results.get('publish-bad-tag')).toContain('must be a label');
    expect(master.results.get('publish-bad-name')).toContain('lowercase slug');

    // The first publication stands, and the same request id publishes once.
    const published = JSON.parse(master.results.get('publish-first')!) as { artifactId: string; version: number };
    expect(published.version).toBe(1);
    expect(published.artifactId).toBe(artifacts[0]);
    const replay = JSON.parse(master.results.get('publish-replay')!) as { artifactId: string; version: number };
    expect(replay.artifactId).toBe(published.artifactId);
    expect(replay.version).toBe(1);

    // The second publication is the second version.
    const second = JSON.parse(master.results.get('publish-second')!) as { artifactId: string; version: number };
    expect(second.artifactId).toBe(published.artifactId);
    expect(second.version).toBe(2);

    // A publication that expects an old head is refused: the head moved on.
    expect(master.results.get('publish-stale')).toContain('Artifact head changed');

    // The document has one head, at version two, with the labels and the schema
    // it was published with.
    const list = JSON.parse(master.results.get('list')!) as { artifacts: { artifactId: string; version: number; tags: string[]; schemaKind: string; schemaVersion: number }[] };
    expect(list.artifacts).toHaveLength(1);
    expect(list.artifacts[0]).toMatchObject({ artifactId: published.artifactId, version: 2, tags: ['known-issue', '编码'], schemaKind: 'source-list', schemaVersion: 1 });

    // Both versions are still readable, and each keeps its own bytes.
    expect(master.results.get('read-one')).toContain('NATIVE_VERSION_ONE');
    expect(master.results.get('read-two')).toContain('NATIVE_VERSION_TWO');
    // The refused publication left nothing behind.
    expect(JSON.stringify(master.results)).not.toContain('STALE_MUST_NOT_PUBLISH');
  } finally {
    await daemon?.close(); await master.close();
    await rm(root, { recursive: true, force: true });
  }
}, 300_000);

test('a publication refuses a path that leaves the work copy and a symbolic link, and never returns the host bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-e2e-go-artifact-source-'));
  const project = join(root, 'project');
  await mkdir(project, { recursive: true });
  await mkdir(join(root, 'web'), { recursive: true });
  await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div id="root">Graph</div>');
  const secret = 'HOST_ONLY_BYTES_MUST_NEVER_REACH_MODEL';
  await writeFile(join(root, 'host-only.txt'), secret);
  await symlink(join(root, 'host-only.txt'), join(project, 'link.txt'));

  const master = await masterProvider(() => [
    { id: 'publish-traversal', name: 'artifact_publish', args: { namespace: 'research', name: 'traversal', sourcePath: '../host-only.txt', requestId: 'traversal' } },
    { id: 'publish-link', name: 'artifact_publish', args: { namespace: 'research', name: 'link', sourcePath: 'link.txt', requestId: 'link' } },
    { id: 'list', name: 'artifact_list', args: { namespace: 'research' } },
  ]);
  let daemon: Awaited<ReturnType<typeof launchCli>> | undefined;

  const request = async (path: string, init: RequestInit = {}) => {
    const response = await daemon!.request(path, init);
    return { status: response.status, body: await response.json().catch(() => ({})) as unknown };
  };

  try {
    const configPath = join(root, 'graph.config.json');
    const entry = { api: 'openai-completions', grade: 'medium', maxTokens: 256, credentialId: 'artifacts' };
    await writeFile(configPath, JSON.stringify({
      version: 1,
      projects: [{ id: 'p', root: project }],
      credentials: { artifacts: { secretRef: 'GRAPH_ARTIFACTS_KEY' } },
      models: { entries: [
        { ...entry, id: 'main', provider: 'graph-master', modelId: 'main-model', grade: 'high', baseUrl: master.baseUrl, contextWindow: 32000 },
      ] },
    }));
    daemon = await launchCli(root, { configPath, env: { GRAPH_ARTIFACTS_KEY: 'artifacts-synthetic' }, extraArgs: ['--execute'] });

    const started = await request('/api/conversations', {
      method: 'POST', body: JSON.stringify({ projectId: 'p', model: 'main', text: 'Publish the requested files.', requestId: 'graph-artifact-source' }),
    });
    expect(started.status, JSON.stringify(started.body)).toBe(200);

    await expect.poll(() => master.results.has('list'), { timeout: 180_000, interval: 250 }).toBeTruthy();
    expect(master.failures, JSON.stringify(master.failures)).toEqual([]);

    // The path that leaves the work copy is refused.
    expect(master.results.get('publish-traversal')).toContain('work copy');
    // The symbolic link is refused.
    expect(master.results.get('publish-link')).toContain('may not be a symbolic link');

    // The bytes behind them never reached the model.
    expect(JSON.stringify(master.requests)).not.toContain(secret);

    // And nothing was published.
    const list = JSON.parse(master.results.get('list')!) as { artifacts: unknown[] };
    expect(list.artifacts).toEqual([]);
  } finally {
    await daemon?.close(); await master.close();
    await rm(root, { recursive: true, force: true });
  }
}, 300_000);
