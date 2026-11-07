import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { launchCli } from '../helpers/cli-daemon.ts';
import { openaiServer } from '../fixtures/openai-server.ts';

/**
 * The instructions the main Agent is given.
 *
 * The main Agent does not start from a blank page: it is handed an identity,
 * a set of rules, a documentation pointer and a list of the tools this
 * session really has. Two of those are switches an installation can turn:
 *
 *   - the search rule can name the search tools that are actually bound to
 *     this session, instead of advertising tools that are not there;
 *   - the documentation pointer can be compacted, for a host that wants a
 *     short prompt instead of a long index.
 *
 * A third switch decides how the maintainer role is worded: whether a failing
 * project check counts as friction in the harness or as work on the project.
 *
 * These switches decide what the Agent believes is true about its host, so
 * they are proven against the request that really left the process - not
 * against a preview of it.
 */

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const close of cleanup.reverse()) await close(); cleanup.length = 0; });

interface ChatBody {
  tools?: { function?: { name?: string } }[];
  messages?: { role?: string; content?: unknown }[];
}

/** The instruction text of one request, whatever role the host sent it under. */
function instructionsOf(body: ChatBody | undefined): string {
  return (body?.messages ?? [])
    .filter(message => message.role === 'system' || message.role === 'developer')
    .map(message => String(message.content ?? ''))
    .join('\n');
}

/** The tool names one request really offered the model. */
function offeredTools(body: ChatBody | undefined): string[] {
  return (body?.tools ?? []).map(tool => tool.function?.name ?? '').filter(Boolean);
}

/** The built-in rule about repository search, word for word. */
const BUILTIN_SEARCH_RULE = '- Search the repository with `rg` through bash for repository search: it is git-aware and fast, and no indexed extension ships with this app any more. Use other shell commands for host facts (git, gh, curl, sqlite, osascript) and for anything no dedicated tool can express.';

async function fixture(options: { matchSearch: boolean; classifyFriction: boolean; ownerRules: boolean }) {
  const root = await mkdtemp(join(tmpdir(), 'graph-e2e-go-agent-context-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  await mkdir(project, { recursive: true });
  await mkdir(join(root, 'web'), { recursive: true });
  await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div id="root">Graph</div>');
  const graphHome = join(root, 'graph-home');
  const ownerRule = '- Search the repository with rg. Custom owner policy.';
  if (options.ownerRules) {
    await mkdir(join(graphHome, 'prompts', 'rules'), { recursive: true });
    // The owner keeps the built-in rule and adds a rule of their own. The host
    // may rewrite its own text; it may not rewrite theirs - not even when
    // their text happens to repeat the built-in rule word for word.
    await writeFile(join(graphHome, 'prompts', 'rules', 'common.md'), [BUILTIN_SEARCH_RULE, ownerRule].join('\n'));
  }
  const provider = await openaiServer(Array.from({ length: 4 }, () => ({ text: 'Understood.' })));
  cleanup.push(() => provider.close());
  const configPath = join(root, 'graph.config.json');
  await writeFile(configPath, JSON.stringify({
    version: 1,
    projects: [{ id: 'p', root: project }],
    credentials: { local: { secretRef: 'GRAPH_LOCAL_KEY' } },
    models: { entries: [{ id: 'local', modelId: 'local', provider: 'graph-openai', grade: 'high', api: 'openai-completions',
      baseUrl: provider.model.baseUrl, contextWindow: 32_000, maxTokens: 256, credentialId: 'local' }] },
  }));
  const daemon = await launchCli(root, {
    configPath,
    env: {
      GRAPH_LOCAL_KEY: 'key-local',
      GRAPH_MATCH_SEARCH_GUIDANCE: options.matchSearch ? '1' : '0',
      GRAPH_CLASSIFY_HARNESS_FRICTION: options.classifyFriction ? '1' : '0',
    },
    extraArgs: ['--execute', '--kernel', 'pig'],
  });
  cleanup.push(() => daemon.close());
  return { root, graphHome, ownerRule, provider, daemon };
}

/** Runs one turn and returns the request the main Agent really sent. */
async function oneTurn(f: Awaited<ReturnType<typeof fixture>>): Promise<ChatBody> {
  const created = await f.daemon.request('/api/conversations', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ projectId: 'p', model: 'local', text: 'Read your instructions.', requestId: 'agent-context' }),
  });
  expect(created.status).toBe(200);
  const { conversationId } = await created.json() as { conversationId: string };
  await expect.poll(async () => {
    const view = await f.daemon.request('/api/conversations/' + conversationId);
    const body = await view.json() as { master?: { status?: string } };
    return body.master?.status;
  }, { timeout: 60_000, interval: 250 }).toBe('succeeded');
  const sent = f.provider.requests.find(request => ((request as ChatBody).tools ?? []).length) as ChatBody | undefined;
  expect(sent, 'the main Agent never sent a request with tools').toBeTruthy();
  return sent!;
}

test('the prompt carries no documentation block', async () => {
  // The prompt used to end with a <docs> section naming docs/agent paths. The
  // Agent reads those files with its own tools like any other source, so the
  // block is gone: a prompt that still advertises it would be telling the model
  // about a section nobody sends.
  const f = await fixture({ matchSearch: true, classifyFriction: false, ownerRules: false });
  const instructions = instructionsOf(await oneTurn(f));
  expect(instructions, 'the <docs> section is still in the prompt').not.toContain('<docs>');
  expect(instructions, 'the prompt still points at the documentation tree').not.toContain('docs/agent/README.md');
  expect(instructions).toContain('<identity>');
  expect(instructions).toContain('<rules>');
}, 120_000);

test('the search rule names only the search tools this session really has', async () => {
  const f = await fixture({ matchSearch: true, classifyFriction: false, ownerRules: false });
  const sent = await oneTurn(f);
  const instructions = instructionsOf(sent);

  expect(instructions).toContain('Repository search tools available in this session:');
  const listed = /Repository search tools available in this session: ([^.]*)\./.exec(instructions)?.[1] ?? '';
  const names = listed.split(',').map(name => name.trim()).filter(Boolean);
  expect(names.length).toBeGreaterThan(0);
  // Every tool the rule advertises is a tool this request really carried.
  const offered = new Set(offeredTools(sent));
  for (const name of names) expect(offered.has(name), `${name} was advertised but not offered`).toBe(true);
}, 120_000);

test('the built-in search rule stays a rule when the host does not ask for the bound list', async () => {
  const f = await fixture({ matchSearch: false, classifyFriction: false, ownerRules: false });
  const instructions = instructionsOf(await oneTurn(f));

  expect(instructions).not.toContain('Repository search tools available in this session:');
  expect(instructions).toContain('- Search the repository with `rg` through bash');
}, 120_000);

test('an owner rule replaces the built-in search rule and is never rewritten', async () => {
  const f = await fixture({ matchSearch: true, classifyFriction: false, ownerRules: true });
  const instructions = instructionsOf(await oneTurn(f));

  expect(instructions).toContain(f.ownerRule);
  // The host may only rewrite its own text. User-owned text is left alone -
  // even when the user kept the built-in rule word for word.
  expect(instructions).toContain(BUILTIN_SEARCH_RULE);
  expect(instructions).not.toContain('Repository search tools available in this session:');
}, 120_000);

test('the maintainer role tells a project failure apart from a harness failure only when asked to', async () => {
  const plain = await fixture({ matchSearch: false, classifyFriction: false, ownerRules: false });
  const plainInstructions = instructionsOf(await oneTurn(plain));
  // The executor and the improver are the same Agent - always.
  expect(plainInstructions).toContain('the executor and the improver are the same Agent');
  expect(plainInstructions).not.toContain('A failing project check, missing project configuration');

  const classified = await fixture({ matchSearch: false, classifyFriction: true, ownerRules: false });
  const classifiedInstructions = instructionsOf(await oneTurn(classified));
  expect(classifiedInstructions).toContain('the executor and the improver are the same Agent');
  expect(classifiedInstructions).toContain('A failing project check, missing project configuration');
}, 240_000);

/**
 * The console's two panels are named after the request they claim to show:
 * `system prompt` and `tool calling`. A panel that shows a reconstruction is
 * worse than no panel - it says what the model was told while the model was
 * told something else. Both are recorded at the send site from the request
 * body itself, so the panel and the wire have to be the same bytes.
 */
test('the context panels show the request that really left the process', async () => {
  const f = await fixture({ matchSearch: true, classifyFriction: false, ownerRules: false });
  const sent = await oneTurn(f);
  const listed = await f.daemon.request('/api/conversations');
  const conversations = await listed.json() as { id?: string }[];
  expect(conversations.length, 'the turn created one conversation').toBe(1);
  const conversationId = conversations[0]!.id!;

  const context = await f.daemon.request(`/api/agent-context?conversationId=${conversationId}`);
  expect(context.status).toBe(200);
  const body = await context.json() as {
    sent?: { operationId?: string; at?: number; text?: string; tools?: string | null } | null;
  };
  const recorded = body.sent;
  expect(recorded, 'the panel says nothing was recorded, but a request was sent').toBeTruthy();

  // The system prompt: exactly the instruction text the request carried.
  expect(recorded!.text).toBe(instructionsOf(sent));

  // Tool calling: exactly the tools array of the same request, in the same
  // order. A panel that shows other tools than the ones offered is a lie about
  // what the model could call.
  expect(recorded!.tools, 'the request offered tools, the panel shows none').toBeTruthy();
  expect(JSON.parse(recorded!.tools!)).toEqual(sent.tools);

  // And it points at the operation that sent it, with a time.
  expect(recorded!.operationId ?? '').not.toBe('');
  expect(recorded!.at ?? 0).toBeGreaterThan(0);

  // A second turn must move the panel with it: the label says "the latest
  // model request", so a panel pinned to the first request would keep
  // describing a request the model is no longer being sent. Turning a tool off
  // is the real console path (`PUT /api/agent-context/tools`), not a fixture
  // trick.
  const offered = (sent.tools ?? []).map(tool => tool.function?.name ?? '').filter(Boolean);
  const dropped = offered.includes('write') ? 'write' : offered[0]!;
  const toggled = await f.daemon.request('/api/agent-context/tools', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ disabled: [dropped] }),
  });
  expect(toggled.status).toBe(200);
  const panelOf = async (id: string) => (await (await f.daemon.request(`/api/agent-context?conversationId=${id}`)).json()) as {
    sent?: { operationId?: string; text?: string; tools?: string | null } | null;
  };
  const latestWire = () => f.provider.requests
    .filter(request => ((request as ChatBody).tools ?? []).length)
    .at(-1) as ChatBody | undefined;
  // A second turn in the conversation that already exists: this is what "the
  // latest model request" has to follow.
  const turn = async (id: string, requestId: string) => {
    const reply = await f.daemon.request(`/api/conversations/${id}/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Read your instructions again.', requestId }),
    });
    expect(reply.status).toBe(200);
  };
  const waitSucceeded = async (id: string) => {
    await expect.poll(async () => {
      const view = await f.daemon.request(`/api/conversations/${id}`);
      const state = await view.json() as { master?: { status?: string } };
      return state.master?.status;
    }, { timeout: 60_000, interval: 250 }).toBe('succeeded');
  };

  // A second turn in the same conversation: the panel has to describe the
  // request that turn really sent, whatever that request contains.
  const before = f.provider.requests.filter(request => ((request as ChatBody).tools ?? []).length).length;
  await turn(conversationId, 'agent-context-2');
  await expect.poll(async () => f.provider.requests.filter(request => ((request as ChatBody).tools ?? []).length).length,
    { timeout: 60_000, interval: 250 }).toBeGreaterThan(before);
  const sameConversation = await panelOf(conversationId);
  expect(sameConversation.sent?.operationId, 'the panel still points at the first request').not.toBe(recorded!.operationId);
  expect(sameConversation.sent?.text).toBe(instructionsOf(latestWire()));
  expect(JSON.parse(sameConversation.sent!.tools!)).toEqual(latestWire()?.tools);

  // A session opened after the toggle is a different session, and the toggle
  // reaches the wire there: the tool the user turned off is not offered, and
  // the panel of that conversation says so too.
  const created = await f.daemon.request('/api/conversations', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ projectId: 'p', model: 'local', text: 'Read your instructions.', requestId: 'agent-context-3' }),
  });
  expect(created.status).toBe(200);
  const fresh = (await created.json()) as { conversationId: string };
  await waitSucceeded(fresh.conversationId);
  const freshWire = latestWire();
  const freshNames = (freshWire?.tools ?? []).map(tool => tool.function?.name ?? '').filter(Boolean);
  expect(freshNames.length, 'the new session still offers tools').toBeGreaterThan(0);
  expect(freshNames, 'the disabled tool is still offered by a session opened after the toggle').not.toContain(dropped);
  const freshPanel = await panelOf(fresh.conversationId);
  expect(freshPanel.sent?.operationId ?? '').not.toBe('');
  expect(freshPanel.sent?.text).toBe(instructionsOf(freshWire));
  expect(JSON.parse(freshPanel.sent!.tools!)).toEqual(freshWire?.tools);
  expect((JSON.parse(freshPanel.sent!.tools!) as { function?: { name?: string } }[]).map(tool => tool.function?.name ?? ''))
    .not.toContain(dropped);
});
