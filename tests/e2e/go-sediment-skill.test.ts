import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { launchCli } from '../helpers/cli-daemon.ts';
import { openaiServer } from '../fixtures/openai-server.ts';

/**
 * A lesson the model proposes becomes a skill in the project - or nothing at all.
 *
 * The rules that decide which one are the product's own: an id that is not a
 * slug, a description that does not say when to use the skill, an empty body
 * and a skill somebody else wrote are all refused, and the refusal means
 * *nothing was written* - not a half-written file, not a directory left behind,
 * and never a file outside the project.
 *
 * The proof is a real daemon, a real master turn that really used a tool, and
 * a real review on the reader model. What the review proposed is what the
 * project gets - so the assertions read the project's own skill folder.
 */

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const close of cleanup.reverse()) await close(); cleanup.length = 0; });

/** A master that really uses a tool, so the sedimentation gate opens. */
async function mainProvider() {
  const server: Server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString()) as { tools?: unknown[]; messages: { role: string; content: unknown }[] };
    const last = body.messages.at(-1);
    const user = [...body.messages].reverse().find(message => message.role === 'user');
    const read = Boolean(body.tools?.length) && last?.role === 'user'
      && JSON.stringify(user?.content).includes('Read the project lesson');
    const delta = read
      ? { role: 'assistant', tool_calls: [{ index: 0, id: 'read-lesson', type: 'function', function: { name: 'read', arguments: JSON.stringify({ path: 'lesson.txt' }) } }] }
      : { role: 'assistant', content: 'Read the concrete project lesson' };
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: read ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 40, completion_tokens: 10 } })}\n\n`);
    response.end('data: [DONE]\n\n');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); },
  };
}

/** A reader that answers with the proposal the turn asked about. */
async function reviewReader() {
  const requests: unknown[] = [];
  const server: Server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString()) as { messages: { role: string; content: unknown }[] };
    requests.push(body);
    let proposal: unknown = { action: 'nothing', id: 'none', reason: 'Nothing reusable' };
    for (const message of body.messages) {
      if (message.role !== 'user' || typeof message.content !== 'string') continue;
      try {
        const payload = JSON.parse(message.content) as { existingSkills?: unknown; reply?: unknown; lastUserMessage?: string };
        if (!Array.isArray(payload.existingSkills) || typeof payload.reply !== 'string') continue;
        proposal = proposalFor(payload.lastUserMessage ?? '');
      } catch { /* not the review payload */ }
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', content: JSON.stringify(proposal) }, finish_reason: null }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 40, completion_tokens: 10 } })}\n\n`);
    response.end('data: [DONE]\n\n');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); },
  };
}

const CREATED = {
  action: 'create',
  id: 'console-e2e-authoring',
  description: 'Use when a console page needs proof rather than a screenshot of the code.',
  body: '# Console E2E authoring\n\n1. Boot a throwaway daemon with a temp state directory.\n2. Drive the real bundle in a browser.\n',
};
const ESCAPING = { action: 'create', id: '../outside', description: 'Use when escaping the project.', body: '# x' };
const VAGUE = { action: 'create', id: 'vague-helper', description: 'A helper for the thing.', body: '# x' };
const FOREIGN = { action: 'update', id: 'theirs', description: 'Use when in doubt.', body: '# theirs, rewritten' };

/** The proposal a review answers with, named by the turn that asked for it. */
function proposalFor(text: string): unknown {
  if (text.includes('case=escape')) return ESCAPING;
  if (text.includes('case=vague')) return VAGUE;
  if (text.includes('case=foreign')) return FOREIGN;
  if (text.includes('case=create')) return CREATED;
  return { action: 'nothing', id: 'none', reason: 'Nothing reusable' };
}

test('a sedimented lesson lands as a self-authored skill, and the shape rules refuse what must not be written', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-e2e-go-sediment-skill-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  await mkdir(project, { recursive: true });
  await writeFile(join(project, 'lesson.txt'), 'A concrete lesson from the user project.');
  await mkdir(join(root, 'web'), { recursive: true });
  await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div id="root">Graph</div>');
  // Somebody else's skill: the daemon must not rewrite it.
  await mkdir(join(project, '.agents', 'skills', 'theirs'), { recursive: true });
  await writeFile(join(project, '.agents', 'skills', 'theirs', 'SKILL.md'),
    '---\nname: theirs\ndescription: Somebody else wrote this. Use when in doubt.\n---\nSomebody else wrote this\n');

  const main = await mainProvider();
  cleanup.push(() => main.close());
  // The reader answers with the proposal this turn is about: the review runs
  // more than once per turn, so the answer cannot be "the next one in line".
  const reader = await reviewReader();
  cleanup.push(() => reader.close());

  const configPath = join(root, 'graph.config.json');
  const entry = { id: 'main', provider: 'graph-main', modelId: 'main-model', grade: 'high', api: 'openai-completions',
    baseUrl: main.baseUrl, contextWindow: 32000, maxTokens: 256, credentialId: 'main' };
  const document = {
    version: 1,
    projects: [{ id: 'p', root: project }],
    credentials: { main: { secretRef: 'GRAPH_MAIN_KEY' }, reader: { secretRef: 'GRAPH_READER_KEY' } },
    models: { entries: [entry, { ...entry, id: 'reader', provider: 'graph-reader', modelId: 'reader-model', grade: 'low', credentialId: 'reader', baseUrl: reader.baseUrl }] },
    skills: { sedimentation: { enabled: true, afterToolCalls: 1, model: 'reader', budgetTokens: 20000 } },
  };
  await writeFile(configPath, JSON.stringify(document, null, 2));

  const daemon = await launchCli(root, {
    configPath, env: { GRAPH_MAIN_KEY: 'main-synthetic', GRAPH_READER_KEY: 'reader-synthetic' }, extraArgs: ['--execute', '--dynamic'],
  });
  cleanup.push(() => daemon.close());
  const request = async (path: string, init: RequestInit = {}) => {
    const response = await daemon.request(path, init);
    return { status: response.status, body: await response.json().catch(() => ({})) as unknown };
  };
  /** The reviews the daemon really asked the reader for. */
  const reviews = () => reader.requests.filter(entry => {
    const body = entry as { messages?: { role: string; content: unknown }[] };
    return body.messages?.some(message => {
      if (message.role !== 'user' || typeof message.content !== 'string') return false;
      try {
        const payload = JSON.parse(message.content) as { existingSkills?: unknown; reply?: unknown };
        return Array.isArray(payload.existingSkills) && typeof payload.reply === 'string';
      } catch { return false; }
    });
  });
  /** One turn that really uses a tool, so one review is earned. */
  const turn = async (text: string, requestId: string) => {
    const before = reviews().length;
    const created = await request('/api/conversations', {
      method: 'POST', body: JSON.stringify({ projectId: 'p', model: 'main', text, requestId }),
    });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    const conversationId = (created.body as { conversationId: string }).conversationId;
    await expect.poll(() => reviews().length, { timeout: 60_000, interval: 250 }).toBe(before + 1);
    return conversationId;
  };
  /** What the daemon recorded about the review it ran. */
  const reviewRecord = async (conversationId: string) => {
    const events = await request(`/api/conversations/${conversationId}/events?after=0&limit=400`);
    const rows = Array.isArray(events.body) ? events.body as { type?: string; data?: unknown }[] : [];
    const record = rows.filter(row => row.type === 'skill_sediment.reviewed').at(-1);
    return record?.data as { written?: { id: string; path: string }[]; refused?: string[]; reviewed?: boolean } | undefined;
  };

  const skillsRoot = join(project, '.agents', 'skills');

  // ① A lesson lands as a self-authored skill.
  const first = await turn('Read the project lesson with your real tool [case=create]', 'turn-1');
  const written = join(skillsRoot, CREATED.id, 'SKILL.md');
  expect(existsSync(written), `the lesson was not written as a skill: ${JSON.stringify(await reviewRecord(first))}`).toBe(true);
  const document_ = await readFile(written, 'utf8');
  expect(document_).toContain('created-by: graph-agent');
  expect(document_).toContain(CREATED.description);
  expect(document_).toContain('Boot a throwaway daemon');

  // ② The next review sees it as an existing skill of the project.
  await turn('Read the project lesson with your real tool [case=create]', 'turn-2');
  const second = reviews()[1]!;
  const payload = JSON.stringify(second);
  expect(payload).toContain(CREATED.id);

  // ③ An id that escapes the project folder is refused, and nothing is written.
  await turn('Read the project lesson with your real tool [case=escape]', 'turn-3');
  expect(existsSync(join(root, 'outside', 'SKILL.md')), 'a skill was written outside the project').toBe(false);
  expect(existsSync(join(skillsRoot, 'outside'))).toBe(false);

  // ④ A description that never says when to use the skill is refused, and no
  //    directory is left behind.
  await turn('Read the project lesson with your real tool [case=vague]', 'turn-4');
  expect(existsSync(join(skillsRoot, VAGUE.id))).toBe(false);

  // ⑤ Somebody else's skill is not rewritten.
  await turn('Read the project lesson with your real tool [case=foreign]', 'turn-5');
  const foreign = await readFile(join(skillsRoot, 'theirs', 'SKILL.md'), 'utf8');
  expect(foreign).toContain('Somebody else wrote this');
  expect(foreign).not.toContain('theirs, rewritten');

  // The folder holds exactly the skill the daemon wrote.
  expect((await readdir(skillsRoot)).filter(name => !name.startsWith('.')).sort()).toEqual([CREATED.id, 'theirs']);
}, 300_000);
