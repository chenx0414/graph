import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { expect, test } from 'vitest';
import { launchCli } from '../helpers/cli-daemon.ts';
import { openaiServer } from '../fixtures/openai-server.ts';

const git = (cwd: string, args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();

/**
 * Who ended an answer that arrived with half a tool call.
 *
 * A tool call's arguments arrive as a stream of text, and they can stop early
 * for two very different reasons: the transport died, or the answer ran out of
 * output budget. The runtime must not report the second as the first - a
 * reader told "the provider cut the arguments" goes looking at the network,
 * while a reader told "the reply hit the output limit" knows the call was too
 * big and shrinks it.
 *
 * The measured case: the evaluation's main agent called `validate_proposal`
 * with a whole graph definition, the provider stopped at its output budget,
 * and the failure that landed in the ledger blamed the provider.
 */

async function projectFixture(root: string): Promise<string> {
  const project = join(root, 'project');
  await mkdir(project, { recursive: true });
  await writeFile(join(project, 'README.md'), '# Tool argument budget project\n');
  git(project, ['init', '-q', '-b', 'main']);
  git(project, ['config', 'user.email', 'graph@example.invalid']);
  git(project, ['config', 'user.name', 'Graph Test']);
  git(project, ['add', '.']);
  git(project, ['commit', '-q', '-m', 'initial']);
  return project;
}

test('an answer that ran out of output budget is not reported as a provider that cut the arguments', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-tool-args-limit-'));
  const project = await projectFixture(root);
  await mkdir(join(root, 'web'), { recursive: true });
  await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div id="root">Graph</div>');

  // The call the model was asked to make is bigger than the room it had: the
  // arguments stop mid-JSON and the provider says why - it ran out of budget.
  const cut = '{"definition":{"schemaVersion":2,"name":"proposed","nodes":{"alpha":{"recipe":"coder@1","task":"WORK';
  const provider = await openaiServer([{
    tools: [{ id: 'call-proposal', name: 'validate_proposal', arguments: cut }],
    finishReason: 'length',
  }]);

  const configPath = join(root, 'graph.config.json');
  await writeFile(configPath, JSON.stringify({
    version: 1,
    projects: [{ id: 'p', root: project }],
    credentials: { local: { secretRef: 'GRAPH_TOOL_ARGS_KEY' } },
    models: { entries: [{ id: 'local', provider: 'graph-openai', grade: 'high',
      api: 'openai-completions', baseUrl: provider.model.baseUrl, contextWindow: 32000, maxTokens: 512,
      credentialId: 'local' }] },
  }));

  let daemon: Awaited<ReturnType<typeof launchCli>> | undefined;
  try {
    daemon = await launchCli(root, { configPath, env: { GRAPH_TOOL_ARGS_KEY: 'synthetic-tool-args-key' }, extraArgs: ['--execute'] });
    const request = async (path: string, method = 'GET', data?: unknown) => {
      const reply = await daemon!.request(path, { method, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
      return { status: reply.status, body: await reply.json().catch(() => ({})) };
    };
    const created = await request('/api/conversations', 'POST', {
      projectId: 'p', model: 'local', text: 'Propose the change.', requestId: 'tool-args-limit-1',
    });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    const conversationId = (created.body as { conversationId: string }).conversationId;

    let view: unknown = {};
    await expect.poll(async () => {
      const reply = await request(`/api/conversations/${conversationId}`);
      view = reply.body;
      const messages = (reply.body as { messages?: { role?: string; kind?: string }[] }).messages ?? [];
      return messages.some(message => message.role === 'system' && message.kind === 'error');
    }, { timeout: 60000, interval: 250 }).toBe(true);

    const messages = (view as { messages?: { role?: string; kind?: string; text?: string }[] }).messages ?? [];
    const failure = messages.find(message => message.role === 'system' && message.kind === 'error')?.text ?? '';
    // What the reader sees names the truncation, and does not send them to the
    // network for a budget problem.
    expect(failure).toMatch(/截断/);
    expect(failure).not.toMatch(/provider cut/i);

    // The ledger keeps the whole story: which call did not fit, and why. That
    // is what a later turn (or the person reading the evidence) needs in order
    // to shrink the call instead of re-dialling the provider.
    const operations = await request(`/api/tasks/${(created.body as { taskId: string }).taskId}/operations?latest=true`);
    const raw = JSON.stringify(operations.body);
    expect(raw).toContain('output token limit');
    expect(raw).toContain('validate_proposal');
    expect(raw).not.toMatch(/provider cut/i);
  } finally {
    await daemon?.close();
    await provider.close();
    await rm(root, { recursive: true, force: true });
  }
}, 120000);
