import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { fullAccessPolicy } from '../../src/core/access-policy.ts';
import { launchCli } from '../helpers/cli-daemon.ts';

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const close of cleanup.reverse()) await close(); cleanup.length = 0; });

interface ProviderBody {
  tools?: { function: { name: string } }[];
  messages: { role: string; content: unknown; tool_call_id?: string }[];
}

function sse(response: import('node:http').ServerResponse, delta: Record<string, unknown>, finish: string): void {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
  response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: finish }], usage: { prompt_tokens: 80, completion_tokens: 20 } })}\n\n`);
  response.end('data: [DONE]\n\n');
}

test('a lesson claimed on the general axis is already in the next task of the project, while a domain lesson is not', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-e2e-harness-prompt-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  await mkdir(project, { recursive: true });

  // Every request the main Agent sends carries its system prompt, so the
  // second conversation proves what the next task starts with.
  const prompts: { system: string; user: string }[] = [];
  const main = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString()) as ProviderBody;
    const isMain = body.tools?.some(tool => tool.function.name === 'record_harness_decision') ?? false;
    if (isMain) {
      // The system prompt is the first message; the user's request tells the
      // two conversations apart.
      const system = body.messages.find(message => message.role === 'system' || message.role === 'developer');
      const user = body.messages.find(message => message.role === 'user');
      prompts.push({
        system: typeof system?.content === 'string' ? system.content : JSON.stringify(system?.content ?? ''),
        user: typeof user?.content === 'string' ? user.content : JSON.stringify(user?.content ?? ''),
      });
      const tools = body.messages.filter(message => message.role === 'tool');
      const alreadyRecorded = tools.some(message => typeof message.content === 'string' && message.content.includes('chosen'));
      if (!alreadyRecorded) {
        sse(response, { role: 'assistant', tool_calls: [
          { index: 0, id: 'general-lesson', type: 'function', function: { name: 'record_harness_decision', arguments: JSON.stringify({
            domain: 'parser', axis: 'general', chosen: 'A',
            cue: 'A document arrives with a stray trailing line.',
            lesson: 'Trim the trailing empty line before parsing.',
            evidence: 'The general candidate parsed the document where the previous run did not.',
          }) } },
          { index: 1, id: 'domain-lesson', type: 'function', function: { name: 'record_harness_decision', arguments: JSON.stringify({
            domain: 'parser', axis: 'specific', chosen: 'B',
            cue: 'This parser keeps its columns in the first row.',
            lesson: 'Read the header row before mapping the columns.',
            evidence: 'The domain candidate mapped the columns from the header.',
          }) } },
        ] }, 'tool_calls');
        return;
      }
    }
    sse(response, { role: 'assistant', content: isMain ? 'Lessons recorded.' : 'No suggestion' }, 'stop');
  });
  await new Promise<void>(resolve => main.listen(0, '127.0.0.1', resolve));
  cleanup.push(async () => { main.closeAllConnections(); await new Promise<void>(resolve => main.close(() => resolve())); });
  const mainUrl = `http://127.0.0.1:${(main.address() as AddressInfo).port}/v1`;

  const webDir = join(root, 'web');
  await mkdir(webDir);
  await writeFile(join(webDir, 'index.html'), '<!doctype html><div id="root">Graph</div>');
  const configPath = join(root, 'graph.config.json');
  await writeFile(configPath, JSON.stringify({
    version: 1,
    projects: [{ id: 'p', root: project }],
    access: fullAccessPolicy(),
    credentials: { local: { secretRef: 'GRAPH_LOCAL_KEY' } },
    models: { entries: [
      { id: 'local', provider: 'graph-local', grade: 'high', api: 'openai-completions', baseUrl: mainUrl, contextWindow: 32000, maxTokens: 4096, credentialId: 'local' },
    ] },
  }));
  const daemon = await launchCli(root, { configPath, extraArgs: ['--execute'], env: { GRAPH_LOCAL_KEY: 'harness-prompt-key' } });
  cleanup.push(() => daemon.close());

  // The first conversation records the two lessons.
  const first = await daemon.request('/api/conversations', {
    method: 'POST',
    body: JSON.stringify({ projectId: 'p', model: 'local', text: 'Record what we learned', requestId: 'harness-prompt-first' }),
  });
  expect(first.status).toBe(200);
  const firstDeadline = Date.now() + 60000;
  while (!prompts.some(entry => entry.user.includes('Record what we learned')) && Date.now() < firstDeadline) {
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  expect(prompts.some(entry => entry.user.includes('Record what we learned'))).toBe(true);

  // The second conversation is a different task of the same project.
  const before = prompts.length;
  const second = await daemon.request('/api/conversations', {
    method: 'POST',
    body: JSON.stringify({ projectId: 'p', model: 'local', text: 'Do unrelated work', requestId: 'harness-prompt-second' }),
  });
  expect(second.status).toBe(200);
  const secondDeadline = Date.now() + 60000;
  while (prompts.length <= before && Date.now() < secondDeadline) {
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  const later = prompts.filter(entry => entry.user.includes('Do unrelated work')).map(entry => entry.system).join('\n');
  expect(later).not.toBe('');
  // The general lesson is already there, before the Agent asks for it.
  expect(later).toContain('Lessons earlier runs of this project learned');
  expect(later).toContain('Trim the trailing empty line before parsing.');
  // The domain lesson is not: it needs a domain, and this task has none.
  expect(later).not.toContain('Read the header row before mapping the columns.');
}, 150_000);
