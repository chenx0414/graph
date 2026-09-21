import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { openAgentContextLibrary } from '../../src/runtime/agent-context.ts';

const cleanup: string[] = [];
afterEach(async () => {
  for (const root of cleanup.splice(0)) await rm(root, { recursive: true, force: true });
});

async function temp() {
  const root = await mkdtemp(join(tmpdir(), 'graph-agent-context-'));
  cleanup.push(root);
  return root;
}

test('the Agent context library exposes defaults, saves overrides, and renders bounded variables', async () => {
  const root = await temp();
  const library = openAgentContextLibrary(root, {
    identity: 'Default Main identity',
    mainGraph: 'Models: {{models}}; requirement {{requirementVersion}}',
  });
  await library.ensure();

  const initial = await library.view({ models: 'local', requirementVersion: '7' });
  const main = initial.prompts.find(prompt => prompt.key === 'agents/main.md');
  const graph = initial.prompts.find(prompt => prompt.key === 'runtime/main-graph.md');
  expect(main).toMatchObject({ content: 'Default Main identity', customized: false });
  expect(graph).toMatchObject({ content: 'Models: local; requirement 7', customized: false });
  expect(await readFile(join(root, 'agents/main.md'), 'utf8')).toBe('Default Main identity\n');
  expect(await readFile(join(root, 'runtime/main-graph.md'), 'utf8')).toBe('Models: {{models}}; requirement {{requirementVersion}}\n');

  await library.savePrompt('runtime/main-graph.md', 'Use {{models}} for requirement {{requirementVersion}}.');
  expect(await library.prompt('runtime/main-graph.md', { models: 'x', requirementVersion: '8' }))
    .toBe('Use x for requirement 8.');
  expect(await readFile(join(root, 'runtime/main-graph.md'), 'utf8')).toBe('Use {{models}} for requirement {{requirementVersion}}.\n');
  expect((await library.view({ models: 'local', requirementVersion: '7' })).prompts.find(prompt => prompt.key === 'runtime/main-graph.md'))
    .toMatchObject({ customized: true });
});

test('tool enablement is persisted as a normalized list', async () => {
  const root = await temp();
  const library = openAgentContextLibrary(root);
  await library.ensure();
  expect(await library.disabledTools()).toEqual([]);

  await library.setDisabledTools(['write_file', 'run_command', 'write_file', ' ']);
  expect(await library.disabledTools()).toEqual(['run_command', 'write_file']);
  expect(JSON.parse(await readFile(join(root, 'tools.json'), 'utf8'))).toEqual({
    version: 1,
    disabled: ['run_command', 'write_file'],
  });
});

test('legacy tool awareness is migrated into the structured tools directory', async () => {
  const root = await temp();
  await mkdir(root, { recursive: true, mode: 0o700 });
  await writeFile(join(root, 'tool-awareness.md'), 'Legacy custom tool guidance.\n', { mode: 0o600 });

  const library = openAgentContextLibrary(root);
  await library.ensure();

  expect(await readFile(join(root, 'tools/main.md'), 'utf8')).toBe('Legacy custom tool guidance.\n');
  expect(await library.prompt('tools/main.md')).toBe('Legacy custom tool guidance.');

  await library.resetPrompt('tools/main.md');
  expect(await library.prompt('tools/main.md')).toBe('');
});

test('the unchanged capability-awareness tool prompt migrates to empty without touching custom guidance', async () => {
  const root = await temp();
  await mkdir(join(root, 'tools'), { recursive: true, mode: 0o700 });
  const capabilityAwareness = [
    '# Capability awareness',
    '',
    'The capability bundle is scoped to this Agent instance and the exact definition version in the briefing.',
    '',
    'Use Skills as on-demand instructions: read the declared `SKILL.md` before applying one. Use MCP and extension tools through their declared names. Resolve file references inside the assigned workspace unless the tool explicitly says otherwise.',
    '',
    'Every model, command, MCP, and extension call is governed by Graph. If a call is blocked by pause, budget, permission, or recovery rules, stop and report the blocking reason instead of inventing another route.',
    '',
  ].join('\n');
  await writeFile(join(root, 'tools/main.md'), capabilityAwareness);

  const library = openAgentContextLibrary(root);
  await library.ensure();

  expect(await library.prompt('tools/main.md')).toBe('');
  expect(await readFile(join(root, 'tools/main.md'), 'utf8')).toBe('\n');
});

test('the unchanged Main Agent identity heading is removed during migration', async () => {
  const root = await temp();
  await mkdir(join(root, 'agents'), { recursive: true, mode: 0o700 });
  const identity = [
    'You are the Master Agent for one Graph feature task. You talk directly with the user, investigate the project, expose uncertainty, and turn the confirmed goal into a reviewable task graph.',
    '',
    'Keep your identity stable across models. Use the native Pi tools to investigate and make workspace changes when the user\'s request requires them, while keeping changes scoped to the request and confirmed graph. Ask only questions whose answers change the plan, preserve confirmed decisions, and submit a new draft when the user changes direction.',
  ].join('\n');
  await writeFile(join(root, 'agents/main.md'), `# Master Agent identity\n\n${identity}\n`);

  const library = openAgentContextLibrary(root, { identity });
  await library.ensure();

  expect(await library.prompt('agents/main.md')).toBe(identity);
  expect(await readFile(join(root, 'agents/main.md'), 'utf8')).toBe(`${identity}\n`);
});

test('unchanged legacy rule defaults migrate to the compact rule set', async () => {
  const root = await temp();
  await mkdir(join(root, 'rules'), { recursive: true, mode: 0o700 });
  await mkdir(join(root, 'runtime'), { recursive: true, mode: 0o700 });
  await writeFile(join(root, 'rules/common.md'), 'Use tool results as evidence.\n');
  await writeFile(join(root, 'rules/main.md'), 'Recipe names use a readable identity plus role, such as `Bob_coder` or `Alice_reviewer`; preserve that name when presenting an Agent and pair it with the stable recipe id.\n');
  await writeFile(join(root, 'runtime/main-conversation.md'), 'Use list_agent_combinations/get_agent_combination. Recipe names use a human-readable identity plus role, such as Bob_coder or Alice_reviewer; preserve that name when presenting the Agent and pair it with the stable recipe id. Call get_agent_combination with the recipe id only.\n');
  await writeFile(join(root, 'runtime/main-graph.md'), 'Submit the graph.\n{{selfModelSection}}\n');

  const library = openAgentContextLibrary(root);
  await library.ensure();

  expect(await library.prompt('rules/common.md')).toBe('- Use tool results as evidence.');
  expect(await library.prompt('rules/main.md')).toContain('Recipe names use a readable identity plus role');
  expect(await library.prompt('runtime/main-conversation.md')).not.toContain('Recipe names use');
  expect(await library.prompt('runtime/main-graph.md')).not.toContain('selfModelSection');
});

test('unknown prompt keys and invalid tool names are refused', async () => {
  const root = await temp();
  const library = openAgentContextLibrary(root);
  await library.ensure();

  await expect(library.savePrompt('../outside.md' as never, 'x')).rejects.toThrow('Unknown Agent prompt');
  await expect(library.savePrompt('docs/INDEX.md' as never, 'x')).rejects.toThrow('Unknown Agent prompt');
  await expect(library.setDisabledTools(['bad\nname'])).rejects.toThrow('Invalid tool name');
});
