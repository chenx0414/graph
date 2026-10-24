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

// The backlog the retired convention used: a markdown document with one item
// per bullet, under a heading that says where the items stand.
const LEGACY_BACKLOG = `# Harness backlog — Graph self-improvement items

One line per item. Status: open | fixed@<commit> | rejected.

## Open

- **HB-901** — the read tool returned nothing for a file that exists, so the turn looked at the wrong path.

## Fixed

- **HB-902** — a stale cache served the old bundle. Fixed@\`abc1234\`.
`;

test('a lesson completes the friction it belongs to, and the retired backlog reads into the same list', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-e2e-harness-lifecycle-'));
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
            domain: 'parser', axis: 'general',
            cue: 'A file that is not there.',
            why: 'The turn that looked for it was wasted.',
          } }];
          break;
        case 1:
          calls = [{ id: 'lesson', name: 'record_harness_decision', args: {
            domain: 'parser', axis: 'general', chosen: 'alpha',
            cue: 'A file that is not there.',
            lesson: 'Check the path with ls before reading it.',
            evidence: 'The candidate that listed the directory found the file.',
          } }];
          break;
        case 2:
          calls = [{ id: 'backlog', name: 'artifact_publish', args: {
            namespace: 'plans', name: 'harness-backlog', content: LEGACY_BACKLOG,
            mediaType: 'text/markdown', title: 'Harness backlog', requestId: 'legacy-backlog',
          } }];
          break;
        case 3:
          // A record written under the first shape, published as it was, so the
          // knowledge the store already held is still readable after the model
          // changed.
          calls = [{ id: 'legacy-record', name: 'artifact_publish', args: {
            namespace: 'plans', name: 'harness-experience-parser',
            content: JSON.stringify([{
              domain: 'parser', axis: 'specific', kind: 'friction', status: 'open',
              cue: 'The old record.', lesson: 'Why it mattered then.', evidence: 'abc1234', createdAt: 1,
            }]),
            mediaType: 'application/json', schema: 'graph.harness-experience@1',
            title: 'Harness knowledge: parser', requestId: 'legacy-record',
          } }];
          break;
        case 4:
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
  const daemon = await launchCli(root, { configPath, extraArgs: ['--execute'], env: { GRAPH_LOCAL_KEY: 'harness-lifecycle-key' } });
  cleanup.push(() => daemon.close());

  const first = await daemon.request('/api/conversations', {
    method: 'POST',
    body: JSON.stringify({ projectId: 'p', model: 'local', text: 'Record what we met and what we learned', requestId: 'harness-lifecycle-first' }),
  });
  expect(first.status).toBe(200);

  const deadline = Date.now() + 120000;
  while (!results.get('read') && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 200));

  const read = JSON.parse(results.get('read') || '{}') as {
    entries: { cue: string; status: string; note?: string; lesson?: string; evidence?: string; source?: string; ref?: string }[];
  };

  // One record, two stages: the lesson completed the friction instead of
  // standing next to it, and the friction's own words stayed on it.
  const sameCue = read.entries.filter(entry => entry.cue === 'A file that is not there.');
  expect(sameCue).toHaveLength(1);
  expect(sameCue[0]!.status).toBe('adopted');
  expect(sameCue[0]!.lesson).toContain('Check the path with ls');
  expect(sameCue[0]!.evidence).toContain('listed the directory');
  expect(sameCue[0]!.note).toContain('The turn that looked for it was wasted.');

  // A record written under the first shape is still read: the note it kept in
  // the lesson field comes back as the note, and it stays a suspicion.
  const old = read.entries.find(entry => entry.cue === 'The old record.');
  expect(old).toBeTruthy();
  expect(old!.status).toBe('open');
  expect(old!.note).toContain('Why it mattered then.');
  expect(old!.lesson ?? '').toBe('');
  expect(old!.ref).toBe('abc1234');

  // The retired backlog is the project's own friction history, so it reads
  // into the same list: its items are open, they are not lessons, and the id
  // the project knows them by stays reachable.
  const legacy = read.entries.filter(entry => entry.source === 'backlog');
  expect(legacy).toHaveLength(2);
  const open = legacy.find(entry => entry.cue.includes('the read tool returned nothing'))!;
  expect(open).toBeTruthy();
  expect(open.status).toBe('open');
  expect(open.note ?? '').toContain('HB-901');
  const fixed = legacy.find(entry => (entry.note ?? '').includes('HB-902'))!;
  expect(fixed.status).toBe('fixed');
  expect(fixed.ref).toBe('abc1234');

  // The next task starts with the adopted lesson. The friction and the
  // backlog items are suspicions and stay suspicions.
  const before = prompts.length;
  const second = await daemon.request('/api/conversations', {
    method: 'POST',
    body: JSON.stringify({ projectId: 'p', model: 'local', text: 'Do unrelated work', requestId: 'harness-lifecycle-second' }),
  });
  expect(second.status).toBe(200);
  const secondDeadline = Date.now() + 120000;
  while (prompts.length <= before && Date.now() < secondDeadline) await new Promise(resolve => setTimeout(resolve, 200));
  const later = prompts.filter(entry => entry.user.includes('Do unrelated work')).map(entry => entry.system).join('\n');
  expect(later).toContain('Lessons earlier runs of this project learned');
  expect(later).toContain('Check the path with ls before reading it.');
  expect(later).not.toContain('The turn that looked for it was wasted.');
  expect(later).not.toContain('the read tool returned nothing');
}, 300_000);
