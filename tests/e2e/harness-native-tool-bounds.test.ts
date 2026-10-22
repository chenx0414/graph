import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { git } from '../../src/git/git.ts';
import { launchCli } from '../helpers/cli-daemon.ts';
import { openaiServer } from '../fixtures/openai-server.ts';

/**
 * A native tool answers within its bound, and says what it left out.
 *
 * The upstream SDK truncates every native tool: a listing to 500 entries, a
 * file search to 1000 matches, a content search to 100 matches, and every
 * answer to 50KB. The daemon's own tools had no such bound, so one directory
 * with a hundred thousand files became an eighteen megabyte answer that the
 * runtime then carried through every later turn.
 *
 * The bound is what makes the answer usable, and the notice is what makes it
 * honest: an answer that looks whole while it is cut is worse than no answer.
 */

interface ProviderMessage {
  role?: string;
  content?: unknown;
}

interface ProviderRequest {
  messages?: ProviderMessage[];
}

/** The text of the tool result the latest tool call answered. */
function toolResult(request: ProviderRequest | undefined): string {
  const results = (request?.messages ?? [])
    .filter(message => message.role === 'tool')
    .map(message => String(message.content ?? ''));
  return results[results.length - 1] ?? '';
}

test('the native tools answer within their bound and say what they left out', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-e2e-native-bounds-'));
  const project = join(root, 'project');
  await mkdir(join(project, 'many'), { recursive: true });
  await mkdir(join(root, 'web'), { recursive: true });
  await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div id="root">Graph</div>');
  await writeFile(join(project, 'README.md'), '# Native tool bounds\n');
  // The listing the daemon must cut: more entries than the bound allows.
  for (let index = 0; index < 1200; index += 1) {
    await writeFile(join(project, 'many', `entry-${String(index).padStart(4, '0')}.txt`), 'x\n');
  }
  // A file with more lines than a read returns.
  const longFile = Array.from({ length: 3000 }, (_, index) => `line ${index + 1}`).join('\n');
  await writeFile(join(project, 'long.txt'), longFile);
  await writeFile(join(project, '.gitignore'), 'many/\n');
  git(project, ['init', '-q', '-b', 'main']);
  git(project, ['config', 'user.email', 'graph@example.invalid']);
  git(project, ['config', 'user.name', 'Graph Test']);
  git(project, ['add', '.']);
  git(project, ['commit', '-q', '-m', 'initial']);

  const provider = await openaiServer([
    { tools: [{ id: 'ls-many', name: 'ls', arguments: JSON.stringify({ path: 'many' }) }] },
    { tools: [{ id: 'find-many', name: 'find', arguments: JSON.stringify({ pattern: '*.txt', path: 'many' }) }] },
    { tools: [{ id: 'read-long', name: 'read', arguments: JSON.stringify({ path: 'long.txt' }) }] },
    { text: 'The bounds are in place.' },
  ]);
  let daemon: Awaited<ReturnType<typeof launchCli>> | undefined;
  const configPath = join(root, 'graph.config.json');
  try {
    await writeFile(configPath, JSON.stringify({
      version: 1,
      projects: [{ id: 'p', root: project }],
      credentials: { local: { secretRef: 'GRAPH_NATIVE_BOUNDS_KEY' } },
      models: { entries: [{ id: 'local', provider: 'graph-openai', grade: 'high',
        api: 'openai-completions', baseUrl: provider.model.baseUrl, contextWindow: 32000, maxTokens: 512,
        credentialId: 'local' }] },
    }));
    daemon = await launchCli(root, { configPath, env: { GRAPH_NATIVE_BOUNDS_KEY: 'synthetic-native-bounds-key' }, extraArgs: ['--execute'] });
    const request = async (path: string, method = 'GET', data?: unknown) => {
      const reply = await daemon!.request(path, { method, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
      return { status: reply.status, body: await reply.json().catch(() => ({})) };
    };
    const created = await request('/api/conversations', 'POST', {
      projectId: 'p', model: 'local', text: 'List the files, find the texts and read the long one.', requestId: 'native-bounds-1',
    });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    const conversationId = (created.body as { conversationId: string }).conversationId;
    await expect.poll(async () => {
      const view = await request(`/api/conversations/${conversationId}`);
      return (view.body as { master?: { status?: string } }).master?.status;
    }, { timeout: 90000, interval: 250 }).toBe('succeeded');

    // The listing answers within the bound and says that it was cut.
    const listing = toolResult(provider.requests[1] as ProviderRequest);
    expect(listing, 'the listing was not answered').toContain('entry-0000.txt');
    expect(listing, 'the listing does not say it was cut').toContain('entries limit reached');
    expect(listing.split('\n').length, 'the listing is longer than the bound').toBeLessThan(520);

    // The file search answers within its own bound.
    const search = toolResult(provider.requests[2] as ProviderRequest);
    expect(search, 'the search was not answered').toContain('entry-0000.txt');
    expect(search, 'the search does not say it was cut').toContain('matches limit reached');
    expect(search.split('\n').length, 'the search is longer than the bound').toBeLessThan(1020);

    // The read answers within the line bound and says how to continue.
    const read = toolResult(provider.requests[3] as ProviderRequest);
    expect(read, 'the read was not answered').toContain('line 1');
    expect(read, 'the read does not say it was cut').toContain('Use offset=');
    expect(read.split('\n').length, 'the read is longer than the bound').toBeLessThan(2010);
  } finally {
    await daemon?.close();
    await provider.close();
    await rm(root, { recursive: true, force: true });
  }
}, 240000);
