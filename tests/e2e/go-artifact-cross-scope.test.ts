import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';

import { launchCli } from '../helpers/cli-daemon.ts';

/**
 * An artifact the artifact tools show is an artifact the artifact tools read -
 * and one they may not read is refused in words that name the boundary.
 *
 * The list a supervisor sees offers its own task's artifacts together with the
 * project knowledge of its project, and promoting really does write project
 * knowledge: a new artifact id in the project scope. Reading that same id used
 * to answer "Artifact not found", because the read was pinned to the task scope:
 * the list showed a document and the read swore it did not exist. The body now
 * comes back, and an artifact of another project - which the list never shows -
 * is refused by a message that says so instead of a silence that looks like a
 * missing document.
 *
 * The proof is a real daemon, real supervisor conversations in two projects, and
 * the same tools a model calls.
 */

interface ToolCall { id?: string; type?: string; function?: { name?: string; arguments?: string } }
interface ChatMessage { role?: string; content?: unknown; tool_call_id?: string; tool_calls?: ToolCall[] }
interface ChatBody { tools?: { function?: { name?: string } }[]; messages?: ChatMessage[] }
interface Step { id: string; name: string; args: unknown }

/**
 * One scripted model: it plays its plan in the order the case needs and keeps
 * every tool answer, so the case reads what the model really read.
 */
async function scriptedModel(plan: (spoken: Set<string>, results: Map<string, string>) => Step | undefined) {
  const results = new Map<string, string>();
  const failures: string[] = [];
  const server: Server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString()) as ChatBody;
    const messages = body.messages ?? [];
    for (const message of messages) {
      if (message.role !== 'tool') continue;
      const content = typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? '');
      results.set(message.tool_call_id ?? '', content);
    }
    const spoken = new Set(messages.flatMap(message => (message.tool_calls ?? []).map(call => call.id ?? '')));
    const frame = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`;
    const say = (delta: unknown, finish: string | null) => response.write(frame({
      id: 'r', choices: [{ index: 0, delta, finish_reason: finish }], usage: { prompt_tokens: 5, completion_tokens: 5 },
    }));
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    let next: Step | undefined;
    try {
      next = (body.tools ?? []).length ? plan(spoken, results) : undefined;
    } catch (error) {
      // A step whose precondition never held ends this turn: the case reads the
      // reason instead of waiting for a plan that can no longer run.
      failures.push(error instanceof Error ? error.message : String(error));
      next = undefined;
    }
    if (!next) {
      say({ role: 'assistant', content: 'Noted.' }, 'stop');
    } else {
      say({ role: 'assistant', tool_calls: [{ index: 0, id: next.id, type: 'function',
        function: { name: next.name, arguments: JSON.stringify(next.args) } }] }, null);
      response.write(frame({ id: 'r', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: {} }));
    }
    response.end('data: [DONE]\n\n');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    results,
    failures,
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); },
  };
}

test('project knowledge a supervisor lists is the body it reads, and another project\'s is refused by name', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-e2e-artifact-scope-'));
  const project = join(root, 'project');
  const elsewhere = join(root, 'elsewhere');
  for (const tree of [project, elsewhere]) {
    await mkdir(tree, { recursive: true });
    await writeFile(join(tree, 'README.md'), '# tree\n');
  }
  await mkdir(join(root, 'web'), { recursive: true });
  await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div id="root">Graph</div>');

  // The other project's supervisor promotes its own knowledge. The first project
  // must be able to name it - and not read it.
  let foreignId = '';
  const otherModel = await scriptedModel((spoken, results) => {
    if (!spoken.has('publish')) {
      return { id: 'publish', name: 'artifact_publish', args: { namespace: 'research', name: 'foreign', schema: 'source-list@1',
        content: '{"note":"OTHER_PROJECT_BODY"}', requestId: 'publish' } };
    }
    if (!spoken.has('promote')) {
      const published = results.get('publish');
      if (!published) return undefined;
      foreignId = (JSON.parse(published) as { artifactId?: string }).artifactId ?? '';
      return { id: 'promote', name: 'artifact_promote', args: { artifactId: foreignId, version: 1, requestId: 'promote' } };
    }
    return undefined;
  });

  // The first project publishes, promotes, then lists what it can see and reads
  // both ids: its own, and the other project's.
  let ownId = '';
  const master = await scriptedModel((spoken, results) => {
    for (const id of ['publish', 'promote', 'list', 'read-own', 'read-foreign']) {
      if (spoken.has(id)) continue;
      if (id === 'publish') {
        return { id, name: 'artifact_publish', args: { namespace: 'research', name: 'knowledge', schema: 'source-list@1',
          content: '{"note":"PROJECT_KNOWLEDGE_BODY"}', requestId: id } };
      }
      if (id === 'promote') {
        const published = results.get('publish');
        if (!published) return undefined;
        const source = (JSON.parse(published) as { artifactId?: string }).artifactId ?? '';
        return { id, name: 'artifact_promote', args: { artifactId: source, version: 1, requestId: id } };
      }
      if (id === 'list') {
        // Promotion writes a new artifact id in the project scope: that id, not
        // the task artifact it came from, is the project knowledge under test.
        const promoted = results.get('promote');
        if (!promoted) return undefined;
        ownId = (JSON.parse(promoted) as { artifactId?: string }).artifactId ?? '';
        return { id, name: 'artifact_list', args: { namespace: 'research' } };
      }
      if (id === 'read-own') {
        const listed = results.get('list');
        if (!listed) return undefined;
        if (!listed.includes(ownId)) throw new Error(`artifact_list did not show the promoted artifact ${ownId}: ${listed}`);
        return { id, name: 'artifact_read', args: { artifactId: ownId, version: 1 } };
      }
      if (!foreignId) return undefined;
      return { id, name: 'artifact_read', args: { artifactId: foreignId, version: 1 } };
    }
    return undefined;
  });

  let daemon: Awaited<ReturnType<typeof launchCli>> | undefined;
  try {
    const configPath = join(root, 'graph.config.json');
    const entry = { api: 'openai-completions', grade: 'medium', maxTokens: 256, credentialId: 'scope' };
    await writeFile(configPath, JSON.stringify({
      version: 1,
      projects: [{ id: 'p', root: project }, { id: 'q', root: elsewhere }],
      credentials: { scope: { secretRef: 'GRAPH_SCOPE_KEY' } },
      models: { entries: [
        { ...entry, id: 'main', provider: 'graph-master', modelId: 'main-model', grade: 'high', baseUrl: master.baseUrl, contextWindow: 32000 },
        { ...entry, id: 'other', provider: 'graph-other', modelId: 'other-model', grade: 'high', baseUrl: otherModel.baseUrl, contextWindow: 32000 },
      ] },
    }));
    daemon = await launchCli(root, { configPath, env: { GRAPH_SCOPE_KEY: 'scope-synthetic' }, extraArgs: ['--execute'] });
    const request = async (path: string, init: RequestInit = {}) => {
      const response = await daemon!.request(path, init);
      return { status: response.status, body: await response.json().catch(() => ({})) as Record<string, any> };
    };
    const openConversation = async (projectId: string, model: string, text: string) => {
      const started = await request('/api/conversations', {
        method: 'POST', body: JSON.stringify({ projectId, model, text, requestId: `scope-${projectId}-${model}` }),
      });
      expect(started.status, JSON.stringify(started.body)).toBe(200);
    };

    // The two projects are ordered here, so the reader is never asked about an
    // artifact that does not exist yet.
    await openConversation('q', 'other', 'Promote the other project knowledge.');
    await expect.poll(() => foreignId, { timeout: 90_000, interval: 250 }).not.toBe('');
    await openConversation('p', 'main', 'Promote our knowledge, then read it back.');

    await expect.poll(() => master.results.has('read-foreign'), { timeout: 120_000, interval: 250 }).toBeTruthy();
    expect(master.failures, JSON.stringify(master.failures)).toEqual([]);
    expect(otherModel.failures, JSON.stringify(otherModel.failures)).toEqual([]);

    // The list showed the promoted artifact, and it is project knowledge.
    const listed = JSON.parse(master.results.get('list')!) as { artifacts: { artifactId: string; scope: string; name: string }[] };
    expect(listed.artifacts.map(item => [item.artifactId, item.scope, item.name]))
      .toContainEqual([ownId, 'project', 'knowledge']);
    // The other project's knowledge is not listed: the list is the reach.
    expect(listed.artifacts.map(item => item.artifactId)).not.toContain(foreignId);

    // Reading what the list showed returns the body, not a refusal.
    const raw = master.results.get('read-own') ?? '';
    expect(raw).toContain('PROJECT_KNOWLEDGE_BODY');
    const read = JSON.parse(raw) as { text: string | null; record: { artifactId: string; scope: string } };
    expect(read.record.artifactId).toBe(ownId);
    expect(read.record.scope).toBe('project');

    // The other project's artifact is refused, and the refusal names the boundary
    // instead of claiming the document does not exist anywhere.
    const refused = master.results.get('read-foreign') ?? '';
    expect(refused).toContain('not found in this task workspace');
    expect(refused).not.toContain('OTHER_PROJECT_BODY');
  } finally {
    await daemon?.close(); await master.close(); await otherModel.close();
    await rm(root, { recursive: true, force: true });
  }
}, 240_000);
