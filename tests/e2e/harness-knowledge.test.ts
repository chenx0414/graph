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
  response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: finish }], usage: { prompt_tokens: 90, completion_tokens: 25 } })}\n\n`);
  response.end('data: [DONE]\n\n');
}

test('friction and adopted lessons live in one store, and only the adopted ones reach the next task', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-e2e-harness-knowledge-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  await mkdir(project, { recursive: true });

  const prompts: { system: string; user: string }[] = [];
  const results = new Map<string, string>();
  let step = 0;
  const main = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString()) as ProviderBody;
    const isMain = body.tools?.some(tool => tool.function.name === 'record_harness_friction') ?? false;
    let calls: { id: string; name: string; args: unknown }[] = [];
    if (isMain) {
      const system = body.messages.find(message => message.role === 'system' || message.role === 'developer');
      const user = body.messages.find(message => message.role === 'user');
      prompts.push({
        system: typeof system?.content === 'string' ? system.content : JSON.stringify(system?.content ?? ''),
        user: typeof user?.content === 'string' ? user.content : JSON.stringify(user?.content ?? ''),
      });
      for (const message of body.messages) {
        if (message.role === 'tool' && message.tool_call_id) {
          results.set(message.tool_call_id, typeof message.content === 'string' ? message.content : JSON.stringify(message.content));
        }
      }
      switch (step) {
        case 0:
          calls = [{ id: 'friction', name: 'record_harness_friction', args: {
            domain: 'parser',
            cue: 'A file that is not there.',
            why: 'The turn that looked for it was wasted.',
          } }];
          break;
        case 1:
          calls = [{ id: 'lesson', name: 'record_harness_decision', args: {
            domain: 'parser', axis: 'general', chosen: 'A',
            cue: 'A document arrives with a stray trailing line.',
            lesson: 'Trim the trailing empty line before parsing.',
            evidence: 'The general candidate parsed the document where the previous run did not.',
          } }];
          break;
        case 2:
          calls = [{ id: 'second-lesson', name: 'record_harness_decision', args: {
            domain: 'parser', axis: 'general', chosen: 'B',
            cue: 'A document arrives with a table in it.',
            lesson: 'Read the header row before mapping the columns.',
            evidence: 'The second candidate mapped the columns from the header.',
          } }];
          break;
        case 3:
          calls = [{ id: 'read', name: 'read_harness_experience', args: { domain: 'parser' } }];
          break;
      }
      step++;
    }
    if (calls.length) {
      sse(response, { role: 'assistant', tool_calls: calls.map((call, index) => ({ index, id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } })) }, 'tool_calls');
      return;
    }
    sse(response, { role: 'assistant', content: isMain ? 'Knowledge recorded.' : 'No suggestion' }, 'stop');
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
  const daemon = await launchCli(root, { configPath, extraArgs: ['--execute'], env: { GRAPH_LOCAL_KEY: 'harness-knowledge-key' } });
  cleanup.push(() => daemon.close());

  const first = await daemon.request('/api/conversations', {
    method: 'POST',
    body: JSON.stringify({ projectId: 'p', model: 'local', text: 'Record what we met and what we learned', requestId: 'harness-knowledge-first' }),
  });
  expect(first.status).toBe(200);

  const deadline = Date.now() + 120000;
  while (!results.get('read') && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 200));

  // One store, two stages: the friction that is open and the lessons that are
  // adopted. The second lesson joins the first: a store that only kept the last
  // entry would have lost the one before it.
  const read = JSON.parse(results.get('read') || '{}') as {
    entries: { kind: string; status: string; axis: string; cue: string; lesson: string }[];
  };
  const friction = read.entries.find(entry => entry.kind === 'friction');
  const lessons = read.entries.filter(entry => entry.kind === 'lesson');
  const lesson = lessons.find(entry => entry.cue.includes('trailing line'));
  expect(friction).toBeTruthy();
  expect(friction!.status).toBe('open');
  expect(friction!.cue).toContain('not there');
  expect(lesson).toBeTruthy();
  expect(lesson!.status).toBe('adopted');
  expect(lesson!.axis).toBe('general');
  expect(lesson!.lesson).toContain('Trim the trailing empty line');
  expect(lessons).toHaveLength(2);
  expect(lessons.some(entry => entry.lesson.includes('Read the header row'))).toBe(true);

  // The next task of the project starts with the adopted lesson - and not with
  // the friction, which is a suspicion and not a lesson.
  const before = prompts.length;
  const second = await daemon.request('/api/conversations', {
    method: 'POST',
    body: JSON.stringify({ projectId: 'p', model: 'local', text: 'Do unrelated work', requestId: 'harness-knowledge-second' }),
  });
  expect(second.status).toBe(200);
  const secondDeadline = Date.now() + 120000;
  while (prompts.length <= before && Date.now() < secondDeadline) await new Promise(resolve => setTimeout(resolve, 200));
  const later = prompts.filter(entry => entry.user.includes('Do unrelated work')).map(entry => entry.system).join('\n');
  expect(later).toContain('Lessons earlier runs of this project learned');
  expect(later).toContain('Trim the trailing empty line before parsing.');
  expect(later).not.toContain('The turn that looked for it was wasted.');
}, 300_000);

test('once the project declares its domain, the lessons of that domain reach the tasks that follow', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-e2e-harness-domain-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  await mkdir(project, { recursive: true });

  const prompts: { system: string; user: string }[] = [];
  const results = new Map<string, string>();
  let step = 0;
  const main = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString()) as ProviderBody;
    const isMain = body.tools?.some(tool => tool.function.name === 'declare_harness_domain') ?? false;
    let calls: { id: string; name: string; args: unknown }[] = [];
    if (isMain) {
      const system = body.messages.find(message => message.role === 'system' || message.role === 'developer');
      const user = body.messages.find(message => message.role === 'user');
      prompts.push({
        system: typeof system?.content === 'string' ? system.content : JSON.stringify(system?.content ?? ''),
        user: typeof user?.content === 'string' ? user.content : JSON.stringify(user?.content ?? ''),
      });
      for (const message of body.messages) {
        if (message.role === 'tool' && message.tool_call_id) {
          results.set(message.tool_call_id, typeof message.content === 'string' ? message.content : JSON.stringify(message.content));
        }
      }
      switch (step) {
        case 0:
          calls = [{ id: 'declare', name: 'declare_harness_domain', args: { domain: 'parser' } }];
          break;
        case 1:
          calls = [{ id: 'lesson', name: 'record_harness_decision', args: {
            domain: 'parser', axis: 'specific', chosen: 'alpha',
            cue: 'This parser keeps its columns in the first row.',
            lesson: 'Read the header row before mapping the columns.',
            evidence: 'The candidate mapped the columns from the header.',
          } }];
          break;
      }
      step++;
    }
    if (calls.length) {
      sse(response, { role: 'assistant', tool_calls: calls.map((call, index) => ({ index, id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } })) }, 'tool_calls');
      return;
    }
    sse(response, { role: 'assistant', content: isMain ? 'Domain declared.' : 'No suggestion' }, 'stop');
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
  const daemon = await launchCli(root, { configPath, extraArgs: ['--execute'], env: { GRAPH_LOCAL_KEY: 'harness-domain-key' } });
  cleanup.push(() => daemon.close());

  const first = await daemon.request('/api/conversations', {
    method: 'POST',
    body: JSON.stringify({ projectId: 'p', model: 'local', text: 'This project parses documents', requestId: 'harness-domain-first' }),
  });
  expect(first.status).toBe(200);
  const deadline = Date.now() + 120000;
  while (!results.get('lesson') && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 200));
  expect(results.get('lesson')).toBeTruthy();

  // The next task of the project starts with the lessons of that domain.
  const before = prompts.length;
  const second = await daemon.request('/api/conversations', {
    method: 'POST',
    body: JSON.stringify({ projectId: 'p', model: 'local', text: 'Parse another document', requestId: 'harness-domain-second' }),
  });
  expect(second.status).toBe(200);
  const secondDeadline = Date.now() + 120000;
  while (prompts.length <= before && Date.now() < secondDeadline) await new Promise(resolve => setTimeout(resolve, 200));
  const later = prompts.filter(entry => entry.user.includes('Parse another document')).map(entry => entry.system).join('\n');
  expect(later).toContain('Lessons earlier runs of this project learned');
  expect(later).toContain('Read the header row before mapping the columns.');
}, 300_000);
