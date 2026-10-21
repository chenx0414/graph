import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { launchCli } from '../helpers/cli-daemon.ts';
import { openaiServer } from '../fixtures/openai-server.ts';

// The kernel has codemode built in: the model writes JavaScript that calls the
// host's tools, and the script runs in the kernel's sandbox. Graph offers the
// tool only when the configuration asks for it.
//
// The proof is a real daemon, a real provider and a real Graph tool: the model
// is offered `codemode`, the model calls it, the script calls the host's own
// `write` tool, the file appears in the work copy, and the answer carries what
// the script saw.

const SCRIPT = [
  'const written = await tools.write({ path: "codemode-proof.txt", content: "written by the sandbox" });',
  'text(written);',
].join('\n');

test('the model runs a script in the kernel sandbox and the script calls the host tools', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-pig-codemode-'));
  const project = join(root, 'project');
  await mkdir(project);
  await mkdir(join(root, 'web'));
  await writeFile(join(root, 'web/index.html'), '<!doctype html><div>Graph</div>');
  const provider = await openaiServer([
    { tools: [{ id: 'call-codemode', name: 'codemode', arguments: JSON.stringify({ code: SCRIPT }) }] },
    { text: 'The sandbox wrote the file.' },
  ]);
  let daemon: Awaited<ReturnType<typeof launchCli>> | undefined;
  try {
    const configPath = join(root, 'graph.config.json');
    await writeFile(configPath, JSON.stringify({ version: 1, projects: [{ id: 'p', root: project }],
      credentials: { local: { secretRef: 'GRAPH_PIG_CODEMODE_KEY' } },
      codemode: { enabled: true },
      models: { entries: [{ id: 'main', provider: 'graph-codemode', grade: 'high', api: 'openai-completions',
        baseUrl: provider.model.baseUrl, contextWindow: 32000, maxTokens: 512, credentialId: 'local' }] } }));
    daemon = await launchCli(root, { configPath, env: { GRAPH_PIG_CODEMODE_KEY: 'synthetic-only' }, extraArgs: ['--execute', '--kernel', 'pig'] });

    const created = await daemon.request('/api/conversations', { method: 'POST', body: JSON.stringify({ projectId: 'p', model: 'main', text: 'Write codemode-proof.txt with the sandbox.', requestId: 'codemode-1' }) });
    expect(created.status).toBe(200);
    const { conversationId } = await created.json() as { conversationId: string };
    const view = async () => await (await daemon!.request(`/api/conversations/${conversationId}`)).json();
    await expect.poll(async () => (await view()).master?.status, { timeout: 60000 }).toBe('succeeded');

    // The model was offered the codemode tool.
    const declared = (provider.requests[0] as { tools?: { function?: { name?: string } }[] }).tools ?? [];
    expect(declared.map(tool => tool.function?.name)).toContain('codemode');
    // The script reached the host's own tool: the file is in the work copy.
    expect(await readFile(join(project, 'codemode-proof.txt'), 'utf8')).toBe('written by the sandbox');
    // The answer carries what the script saw.
    expect(JSON.stringify(provider.requests[1])).toContain('codemode-proof.txt');
    const answers = (await view()).messages.filter((message: { role: string }) => message.role === 'assistant');
    expect(answers.at(-1)?.text).toContain('The sandbox wrote the file.');
  } finally {
    await daemon?.close();
    await provider.close();
    await rm(root, { recursive: true, force: true });
  }
}, 120000);

test('the codemode tool is absent unless the configuration asks for it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-pig-codemode-off-'));
  const project = join(root, 'project');
  await mkdir(project);
  await mkdir(join(root, 'web'));
  await writeFile(join(root, 'web/index.html'), '<!doctype html><div>Graph</div>');
  const provider = await openaiServer([
    { text: 'Nothing to run.', usage: { prompt_tokens: 10, completion_tokens: 5 } },
  ]);
  let daemon: Awaited<ReturnType<typeof launchCli>> | undefined;
  try {
    const configPath = join(root, 'graph.config.json');
    await writeFile(configPath, JSON.stringify({ version: 1, projects: [{ id: 'p', root: project }],
      credentials: { local: { secretRef: 'GRAPH_PIG_CODEMODE_KEY' } },
      models: { entries: [{ id: 'main', provider: 'graph-codemode', grade: 'high', api: 'openai-completions',
        baseUrl: provider.model.baseUrl, contextWindow: 32000, maxTokens: 512, credentialId: 'local' }] } }));
    daemon = await launchCli(root, { configPath, env: { GRAPH_PIG_CODEMODE_KEY: 'synthetic-only' }, extraArgs: ['--execute', '--kernel', 'pig'] });
    const created = await daemon.request('/api/conversations', { method: 'POST', body: JSON.stringify({ projectId: 'p', model: 'main', text: 'Say nothing.', requestId: 'codemode-off' }) });
    expect(created.status).toBe(200);
    const { conversationId } = await created.json() as { conversationId: string };
    await expect.poll(async () => {
      const view = await (await daemon!.request(`/api/conversations/${conversationId}`)).json();
      return view.master?.status;
    }, { timeout: 60000 }).toBe('succeeded');
    const declared = (provider.requests[0] as { tools?: { function?: { name?: string } }[] }).tools ?? [];
    expect(declared.map(tool => tool.function?.name)).not.toContain('codemode');
  } finally {
    await daemon?.close();
    await provider.close();
    await rm(root, { recursive: true, force: true });
  }
}, 120000);
