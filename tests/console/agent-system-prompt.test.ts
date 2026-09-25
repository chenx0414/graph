import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, test } from 'vitest';
import { DEFAULT_MAIN_TOOL_GUIDANCE, openAgentContextLibrary } from '../../src/runtime/agent-context.ts';
import { graphDocumentationPaths } from '../../src/runtime/agent-docs.ts';
import { composeAgentSystemPrompt } from '../../src/runtime/agent-system-prompt.ts';

const cleanup: string[] = [];

afterEach(async () => {
  for (const root of cleanup.splice(0)) await rm(root, { recursive: true, force: true });
});

async function temp() {
  const root = await mkdtemp(join(tmpdir(), 'graph-agent-system-prompt-'));
  cleanup.push(root);
  return root;
}

test('the shared composer renders Graph sections in order and keeps Pi-generated cwd separate', () => {
  const result = composeAgentSystemPrompt({
    identity: 'You are the Main Agent.',
    identityContext: 'Full access is active for this operation.',
    definitionVersion: 'main@7',
    toolGuidance: 'Use the smallest tool that can prove the claim.',
    rules: {
      common: 'Common rule.',
      role: 'Submit a graph draft before dispatching work.',
      runtime: 'Current requirement version: 3.',
    },
    docs: {
      root: '/app/docs/agent',
      main: '/app/docs/agent/README.md',
      examples: '/app/examples',
    },
    // A tool list, a skill block, a cwd or the project context are never inputs:
    // the provider request and the Pi session supply them.
  });

  // Graph renders only what Graph owns: identity, rules, docs. Tools travel in
  // the provider request, and project context, skills and the working directory
  // are appended by the Pi SDK when it builds the prompt, so Graph must not
  // render any of them itself.
  expect(result.sections.map(section => section.id)).toEqual(['identity', 'rules', 'docs']);
  expect(result.text).toContain('<identity>\nYou are the Main Agent.\n\nFull access is active for this operation.\n</identity>');
  expect(result.sections.find(section => section.id === 'identity')?.parts).toEqual([
    expect.objectContaining({ id: 'identity.agent', origin: 'editable' }),
    expect.objectContaining({ id: 'identity.access', origin: 'generated', content: 'Full access is active for this operation.' }),
  ]);
  expect(result.text).toContain('<rules>');
  expect(result.text).toContain('Common rule.');
  expect(result.text).toContain('Submit a graph draft before dispatching work.');
  expect(result.text).toContain('Current requirement version: 3.');
  // Tool guidance and the send gate stay Graph rules, with their own editable
  // source, instead of being part of a capability inventory.
  expect(result.text).toContain('Use the smallest tool that can prove the claim.');
  expect(result.text).toContain('Every model, command, MCP and extension call passes the Graph send gate');
  expect(result.sections.find(section => section.id === 'rules')?.parts.map(part => part.source))
    .toEqual(['rules/common.md', 'rules/<role>.md', 'runtime/*.md', 'tools/<role>.md', undefined, undefined]);
  expect(result.text).toContain('<docs>');
  expect(result.text).toContain('Graph documentation (read when the user asks about Graph itself');
  expect(result.text).toContain('- Main documentation: /app/docs/agent/README.md');
  expect(result.text).toContain('- Additional docs: /app/docs/agent');
  expect(result.text).toContain('- Examples: /app/examples');
  expect(result.text).toContain('resolve topic paths under Additional docs');
  expect(result.text).not.toContain('.graph/prompts/docs');
  // Nothing native is re-rendered here, in any spelling.
  for (const native of [
    '<tools>', '<capabilities>', '<project_context>', '<project_instructions', '<skills>',
    '<available_skills>', '<cwd>', '<pi_cwd>', '<workflow>', 'Current working directory:',
  ]) {
    expect(result.text).not.toContain(native);
  }
});

test('the harness self-improvement paragraph appears only when the host supplies it', () => {
  const base = {
    identity: 'You are the Main Agent.', definitionVersion: 'main@7',
    toolGuidance: 'Use the smallest tool that can prove the claim.',
    rules: { common: 'Common rule.', role: 'Submit a graph draft before dispatching work.' },
    docs: { root: '/app/docs/agent', main: '/app/docs/agent/README.md', examples: '/app/examples' },
  };
  const withRsi = composeAgentSystemPrompt({ ...base, harnessContext: 'HARNESS SELF-MODEL SENTINEL' });
  expect(withRsi.text).toContain('HARNESS SELF-MODEL SENTINEL');
  const without = composeAgentSystemPrompt(base);
  expect(without.text).not.toContain('HARNESS SELF-MODEL SENTINEL');
});

test('the worktree orientation note reaches subagents only', () => {
  const base = {
    identity: 'I am an Agent.',
    definitionVersion: 'main@1',
    toolGuidance: 'Use the tools you are given.',
    rules: { common: 'Be honest.', role: 'Role rules.' },
    docs: graphDocumentationPaths(),
    // (no tool list, skill block, cwd or project context: the Pi session supplies them)
    // (no tool list, skill block, cwd or project context: the Pi session supplies them)
  };
  const worktree = '/home/me/.graph/state/worktrees/task-1/agent-a';
  const main = composeAgentSystemPrompt({ ...base, role: 'main' });
  const worker = composeAgentSystemPrompt({ ...base, role: 'worker' });
  const noWorktree = composeAgentSystemPrompt({ ...base, role: 'worker' });

  // The main Agent already works in the project root; a subagent gets its own
  // worktree and has to be told that this is what it is looking at. The path line
  // itself is the Pi SDK's, so Graph only carries the orientation note.
  expect(main.text).not.toContain('own Git worktree');
  expect(worker.text).toContain('own Git worktree');
  for (const result of [main, worker, noWorktree]) expect(result.text).not.toContain('Current working directory:');
});

test('the Agent context library seeds editable rules and the main tool routing rules', async () => {
  const root = await temp();
  const library = openAgentContextLibrary(root, {
    identity: 'Original identity',
  });
  await library.ensure();

  expect(await readFile(join(root, 'rules/common.md'), 'utf8')).toContain('tool results');
  expect(await readFile(join(root, 'tools/main.md'), 'utf8')).toBe(`${DEFAULT_MAIN_TOOL_GUIDANCE}\n`);
  await expect(readFile(join(root, 'docs/INDEX.md'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });

  await library.savePrompt('rules/common.md', 'Changed common rule.');
  expect(await library.prompt('rules/common.md')).toBe('Changed common rule.');

  await library.resetPrompt('rules/common.md');
  expect(await library.prompt('rules/common.md')).toContain('tool results');
});

test('Graph Agent documentation and examples are resolved from source', async () => {
  const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));
  const paths = graphDocumentationPaths(repositoryRoot);

  expect(paths.root).toBe(join(repositoryRoot, 'docs', 'agent'));
  expect(paths.main).toBe(join(repositoryRoot, 'docs', 'agent', 'README.md'));
  expect(paths.examples).toBe(join(repositoryRoot, 'examples'));
  expect(await readFile(paths.main, 'utf8')).toContain('# Graph Agent Documentation');
  expect(await readFile(join(paths.root, 'INDEX.md'), 'utf8')).toContain('# Graph Agent Documentation');
  expect(await readFile(join(paths.root, 'execution-model.md'), 'utf8')).toContain('# Graph Execution Model');
  expect(await readFile(join(paths.examples, 'README.md'), 'utf8')).toContain('# Examples');
});
