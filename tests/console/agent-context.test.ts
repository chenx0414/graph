import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { DEFAULT_MAIN_RSI_IDENTITY, DEFAULT_MAIN_TOOL_GUIDANCE, openAgentContextLibrary } from '../../src/runtime/agent-context.ts';

const cleanup: string[] = [];
afterEach(async () => {
  for (const root of cleanup.splice(0)) await rm(root, { recursive: true, force: true });
});

async function temp() {
  const root = await mkdtemp(join(tmpdir(), 'graph-agent-context-'));
  cleanup.push(root);
  return root;
}

test('a sediment prompt file seeded by an older version is migrated to the current shape', async () => {
  // The library reads the visible file, not the constant, so a format change has to reach the file
  // that an installation already has — otherwise the new shape is only true on a fresh machine.
  const root = await temp();
  const library = openAgentContextLibrary(root);
  await library.ensure();
  const file = join(root, 'runtime/sediment.md');
  await writeFile(file, [
    'Answer with one JSON object and nothing else:',
    '{"action":"create"|"update"|"nothing","id":"<lowercase-slug>","description":"<one sentence saying when to use it>","body":"<markdown>","reason":"<one line>"}',
    'body is markdown, at most 20000 characters, and is the skill itself.',
    '',
  ].join('\n'));

  await library.ensure();

  const migrated = await readFile(file, 'utf8');
  expect(migrated).toContain('one line of metadata');
  expect(migrated).toContain('```markdown');
  expect(migrated).not.toContain('"body":"<markdown>"');
  expect(migrated).toContain('The fenced block is the skill itself');
  // The runtime reads the same file, so the migration is what the next review actually follows.
  expect(await library.prompt('runtime/sediment.md')).toContain('one line of metadata');
});

test('the Agent context library exposes defaults, saves overrides, and renders bounded variables', async () => {
  const root = await temp();
  const library = openAgentContextLibrary(root, {
    identity: 'Default Main identity',
    sediment: 'Models: {{models}}; requirement {{requirementVersion}}',
  });
  await library.ensure();

  const initial = await library.view({ models: 'local', requirementVersion: '7' });
  const main = initial.prompts.find(prompt => prompt.key === 'agents/main.md');
  const graph = initial.prompts.find(prompt => prompt.key === 'runtime/sediment.md');
  expect(main).toMatchObject({ content: 'Default Main identity', customized: false });
  expect(graph).toMatchObject({ content: 'Models: local; requirement 7', customized: false });
  expect(await readFile(join(root, 'agents/main.md'), 'utf8')).toBe('Default Main identity\n');
  expect(await readFile(join(root, 'runtime/sediment.md'), 'utf8')).toBe('Models: {{models}}; requirement {{requirementVersion}}\n');

  await library.savePrompt('runtime/sediment.md', 'Use {{models}} for requirement {{requirementVersion}}.');
  expect(await library.prompt('runtime/sediment.md', { models: 'x', requirementVersion: '8' }))
    .toBe('Use x for requirement 8.');
  expect(await readFile(join(root, 'runtime/sediment.md'), 'utf8')).toBe('Use {{models}} for requirement {{requirementVersion}}.\n');
  expect((await library.view({ models: 'local', requirementVersion: '7' })).prompts.find(prompt => prompt.key === 'runtime/sediment.md'))
    .toMatchObject({ customized: true });
});

test('a user default can be empty and is restored after later edits', async () => {
  const root = await temp();
  const library = openAgentContextLibrary(root, {
    mainTools: 'Built-in Main tool guidance',
  });
  await library.ensure();

  await library.savePrompt('tools/main.md', 'Temporary override');
  await library.setPromptDefault('tools/main.md', '');
  expect(await library.prompt('tools/main.md')).toBe('');
  expect(await readFile(join(root, 'tools/main.md'), 'utf8')).toBe('\n');
  expect(await readFile(join(root, 'defaults/tools/main.md'), 'utf8')).toBe('\n');

  await library.savePrompt('tools/main.md', 'A later override');
  await library.resetPrompt('tools/main.md');
  expect(await library.prompt('tools/main.md')).toBe('');
  expect((await library.view()).prompts.find(prompt => prompt.key === 'tools/main.md')).toMatchObject({
    content: '',
    defaultContent: '',
    customized: false,
    defaultCustomized: true,
  });
  await library.clearPromptDefault('tools/main.md');
  expect(await library.prompt('tools/main.md')).toBe('Built-in Main tool guidance');
  await expect(readFile(join(root, 'defaults/tools/main.md'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
});

test('tool enablement is persisted as a normalized list', async () => {
  const root = await temp();
  const library = openAgentContextLibrary(root);
  await library.ensure();
  expect(await library.disabledTools()).toEqual(['powershell']);

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
  // Resetting restores the built-in routing rules; an empty default was the old policy.
  expect(await library.prompt('tools/main.md')).toBe(DEFAULT_MAIN_TOOL_GUIDANCE);
});

test('the unchanged capability-awareness tool prompt migrates to the current routing rules without touching custom guidance', async () => {
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

  expect(await library.prompt('tools/main.md')).toBe(DEFAULT_MAIN_TOOL_GUIDANCE);
  expect(await readFile(join(root, 'tools/main.md'), 'utf8')).toBe(`${DEFAULT_MAIN_TOOL_GUIDANCE}\n`);
});

test('the unchanged Main Agent identity heading is removed during migration', async () => {
  const root = await temp();
  await mkdir(join(root, 'agents'), { recursive: true, mode: 0o700 });
  const identity = [
    'You are the Master Agent for one Graph feature task. You talk directly with the user, investigate the project, expose uncertainty, and turn the confirmed goal into a reviewable task graph.',
    '',
    'Keep your identity stable across models. Use the native Pi tools to investigate and make workspace changes when the user\'s request requires them, while keeping changes scoped to the request and confirmed graph. Ask only questions whose answers change the plan, preserve confirmed decisions, and submit a new draft when the user changes direction.',
    '',
    'When a task delivers or changes anything visible in the console (a page, a control, a message row), verify it yourself before asking the user to accept it: open the page with `agent_browser`, assert the elements and the copy you expect (icon instead of text, `data-testid`, `aria-label`, visible wording), exercise the interaction and read the result back out of the DOM, and attach a screenshot as evidence. Then ask the user only for the judgement a human must make. `graph.command` check nodes cannot do this - their sandbox has no window services, so a real browser never runs there - which makes this the master\'s own step, and it never replaces a bound acceptance check.',
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

  const library = openAgentContextLibrary(root);
  await library.ensure();

  // The default a legacy file migrates to is the compact rule set: Pi's own rules first, then
  // Graph's shared rules, while the main role keeps only its takeover rule.
  expect(await library.prompt('rules/common.md')).toContain('- Use bash for file operations like ls, rg, find');
  expect(await library.prompt('rules/common.md')).toContain('- R27 Test level (high level first)');
  expect(await library.prompt('rules/main.md')).toContain('R14 When one node stays blocked for three rounds');
});

test('unknown prompt keys and invalid tool names are refused', async () => {
  const root = await temp();
  const library = openAgentContextLibrary(root);
  await library.ensure();

  await expect(library.savePrompt('../outside.md' as never, 'x')).rejects.toThrow('Unknown Agent prompt');
  await expect(library.savePrompt('docs/INDEX.md' as never, 'x')).rejects.toThrow('Unknown Agent prompt');
  await expect(library.setDisabledTools(['bad\nname'])).rejects.toThrow('Invalid tool name');
});

// The harness identity is the only durable instruction the Main Agent gets about its own
// improvement work, and a compacted context is exactly when it matters. These assertions pin
// the two requirements so removing either one is a visible test failure, not a silent drift.
test('the harness identity records durable harness knowledge and reports it without being asked', () => {
  // The knowledge must live outside the model context, in the store that
  // holds both the friction met and the lessons adopted.
  expect(DEFAULT_MAIN_RSI_IDENTITY).toContain('record_harness_friction');
  expect(DEFAULT_MAIN_RSI_IDENTITY).toContain('record_harness_decision');
  expect(DEFAULT_MAIN_RSI_IDENTITY).toMatch(/compacted/);
  // Only what was adopted may travel into a later task; a friction is a
  // suspicion and the identity has to say so.
  expect(DEFAULT_MAIN_RSI_IDENTITY).toMatch(/Only the adopted lessons travel/);
  // Finishing a work item must include an unprompted report and a proposal.
  expect(DEFAULT_MAIN_RSI_IDENTITY).toMatch(/unprompted/);
  expect(DEFAULT_MAIN_RSI_IDENTITY).toMatch(/propose/);
});
