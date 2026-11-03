import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { execFileSync } from 'node:child_process';
const git = (cwd: string, args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
import { launchCli } from '../helpers/cli-daemon.ts';
import { anthropicMessagesServer } from '../fixtures/anthropic-messages-server.ts';

/**
 * The tool schema the provider actually receives.
 *
 * Every request carries the whole tool surface, and the descriptions are the
 * part the model reads first: they are schema text, not prose about the
 * product. When the descriptions are paragraphs, the schema is mostly prose,
 * and every turn pays for it - twice over, because the schema sits in the
 * cached prefix of every request the session sends.
 *
 * What is asserted here is what a provider would see:
 *
 *   - the schema the request carries is small enough to read (a budget in
 *     characters, not a share that can drift);
 *   - every tool still says what it is for - a description that says nothing
 *     is not a cheaper description, it is a blind tool;
 *   - the rules that keep a tool from being misused survive the compression:
 *     the one that says "ask the user" before a forced reload, the one that
 *     says a command is not a shell, the one that says a published artifact
 *     takes either content or a path and never both.
 */

interface ProviderTool {
  name?: string;
  description?: string;
  input_schema?: unknown;
}

/** The characters the schema spends on prose, across every tool of the request. */
function descriptionChars(tools: ProviderTool[]): number {
  return tools.reduce((total, tool) => total + (tool.description ?? '').length, 0);
}

/** The description of one tool of the request, by name. */
function descriptionOf(tools: ProviderTool[], name: string): string {
  const tool = tools.find(candidate => candidate.name === name);
  expect(tool, `the request declares no tool named ${name}`).toBeTruthy();
  return tool!.description ?? '';
}

async function projectFixture(root: string): Promise<string> {
  const project = join(root, 'project');
  await mkdir(project, { recursive: true });
  await writeFile(join(project, 'README.md'), '# Tool schema project\n');
  git(project, ['init', '-q', '-b', 'main']);
  git(project, ['config', 'user.email', 'graph@example.invalid']);
  git(project, ['config', 'user.name', 'Graph Test']);
  git(project, ['add', '.']);
  git(project, ['commit', '-q', '-m', 'initial']);
  return project;
}

test('the tool schema the provider receives is short enough to read, and keeps the rules that matter', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-tool-schema-'));
  const project = await projectFixture(root);
  await mkdir(join(root, 'web'), { recursive: true });
  await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div id="root">Graph</div>');
  const provider = await anthropicMessagesServer([{ text: 'Understood.' }]);
  let daemon: Awaited<ReturnType<typeof launchCli>> | undefined;
  const configPath = join(root, 'graph.config.json');
  try {
    await writeFile(configPath, JSON.stringify({
      version: 1,
      projects: [{ id: 'p', root: project }],
      credentials: { local: { secretRef: 'GRAPH_TOOL_SCHEMA_KEY' } },
      models: { entries: [{ id: 'local', provider: 'graph-anthropic', grade: 'high',
        api: 'anthropic-messages', baseUrl: provider.baseUrl, contextWindow: 32000, maxTokens: 512,
        credentialId: 'local' }] },
    }));
    daemon = await launchCli(root, { configPath, env: { GRAPH_TOOL_SCHEMA_KEY: 'synthetic-tool-schema-key' }, extraArgs: ['--execute'] });
    // The product entry is the global supervisor, not a legacy conversation:
    // its schema is the one every user's first turn carries.
    const opened = await daemon.request('/api/orchestration/global', {
      method: 'POST', body: JSON.stringify({ requestId: 'schema-global' }),
    });
    const openedBody = await opened.text();
    expect(opened.status, openedBody).toBe(200);
    const { conversationId } = JSON.parse(openedBody) as { conversationId: string };
    const reply = await daemon.request(`/api/conversations/${conversationId}/messages`, {
      method: 'POST',
      body: JSON.stringify({ text: 'What can you do?', requestId: 'schema-1' }),
    });
    expect(reply.status, await reply.text()).toBe(200);

    await expect.poll(() => provider.requests.length, { timeout: 60000, interval: 250 }).toBeGreaterThan(0);
    const tools = (provider.requests[0]!.body.tools ?? []) as ProviderTool[];
    expect(tools.length, 'the request declares no tools').toBeGreaterThan(0);

    // The prose the provider reads on every request of every session.
    const prose = descriptionChars(tools);
    const schema = tools.reduce((total, tool) => total + JSON.stringify(tool.input_schema ?? {}).length, 0);
    // The cap ratchets with the product entry. When the default entry became
    // the global supervisor, the schema grew from 7,485 characters over 50
    // tools to 9,436 over 56: the supervisor gained ask_user, control_task and
    // the work tools. It grew again with the standing goal (independent
    // acceptance), the closure-with-limitations action, and history_search:
    // 10,400 over 54. The cap moved with that scope; the per-tool average
    // keeps one verbose tool from eating the room.
    expect(prose, `the tool schema spends ${prose} characters on descriptions and ${schema} on parameters:\n`
      + tools.map(tool => `${tool.name}: ${(tool.description ?? '').length}`).join('\n'))
      .toBeLessThanOrEqual(10400);
    expect(prose / tools.length, `the ${tools.length} tool descriptions average ${Math.round(prose / tools.length)} characters`)
      .toBeLessThanOrEqual(200);
    // The schema is not mostly prose: the descriptions are no longer the
    // bigger half of what the provider reads.
    expect(prose, `the descriptions are ${prose} characters and the parameters ${schema}: the schema is mostly prose`)
      .toBeLessThan(schema);

    // A cheaper description still has to say what the tool is for.
    for (const tool of tools) {
      expect((tool.description ?? '').trim().length, `the tool ${tool.name} has no description`).toBeGreaterThan(10);
    }

    // The rules that keep a tool from being misused survive the compression.
    const publish = descriptionOf(tools, 'artifact_publish');
    expect(publish, 'the publish tool no longer says content and path are exclusive')
      .toMatch(/never both/i);
    const confirm = descriptionOf(tools, 'confirm_draft');
    expect(confirm, 'the confirmation no longer says it needs the user to have asked')
      .toMatch(/explicitly asked/i);
    const git = descriptionOf(tools, 'git');
    expect(git, 'the git tool no longer says it is read-only').toMatch(/read-only/i);
    const propose = descriptionOf(tools, 'propose_graph');
    expect(propose, 'the graph proposal no longer points at the document with the format')
      .toMatch(/graph-v2\.md/i);
    // A call that never returned leaves its attempt on disk; the model only finds
    // that answer if the tool says so. The status field alone is not discoverable
    // after the turn that would have read it is already gone.
    const inspect = descriptionOf(tools, 'inspect_rsi_status');
    expect(inspect, 'the status tool no longer says an interrupted apply is answered there')
      .toMatch(/interrupt/i);
  } finally {
    await daemon?.close();
    await provider.close();
    await rm(root, { recursive: true, force: true });
  }
}, 180000);
