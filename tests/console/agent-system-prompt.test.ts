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
    projectContext: {
      path: '/work/AGENTS.md',
      content: 'Keep project-specific conventions.',
    },
    tools: [
      {
        name: 'read',
        description: 'Read file contents',
        source: 'Pi',
        group: 'pi_native',
        order: 0,
        parameters: ['path'],
        permission: 'workspace read',
        available: true,
      },
      {
        name: 'artifact_list',
        description: 'List published artifacts.',
        source: 'Graph',
        parameters: [],
        permission: 'task artifact workspace',
        available: true,
      },
    ],
    capabilities: [{
      id: 'browser',
      version: '1.2.0',
      kind: 'mcp',
      name: 'Browser',
      tools: ['browser_open'],
      networkDomains: ['example.com'],
    }],
    cwd: '/home/me/.graph/state/worktrees/task-1/agent-a',
  });

  expect(result.sections.map(section => section.id)).toEqual([
    'identity',
    'tools',
    'rules',
    'docs',
    'project_context',
    'capabilities',
    'cwd',
  ]);
  expect(result.sections.find(section => section.id === 'tools')?.parts.map(part => part.origin))
    .toEqual(['generated', 'editable']);
  expect(result.text).toContain('<identity>\nYou are the Main Agent.\n\nFull access is active for this operation.\n</identity>');
  expect(result.sections.find(section => section.id === 'identity')?.parts).toEqual([
    expect.objectContaining({ id: 'identity.agent', origin: 'editable' }),
    expect.objectContaining({ id: 'identity.access', origin: 'generated', content: 'Full access is active for this operation.' }),
  ]);
  expect(result.text).toContain('<tools>');
  expect(result.text).toContain([
    '- read: Read file contents',
    '',
    'In addition to the tools above, you may have access to the following Graph tools for main@7:',
    '- artifact_list: List published artifacts.',
  ].join('\n'));
  expect(result.text).toContain('Use the smallest tool that can prove the claim.');
  expect(result.text).not.toContain('parameters:');
  expect(result.text).not.toContain('Definition: main@7');
  expect(result.text.indexOf('- read: Read file contents'))
    .toBeLessThan(result.text.indexOf('following Graph tools for main@7'));
  expect(result.text.indexOf('following Graph tools for main@7'))
    .toBeLessThan(result.text.indexOf('- artifact_list: List published artifacts.'));
  expect(result.text).toContain('<rules>');
  expect(result.text).toContain('Common rule.');
  expect(result.text).toContain('Submit a graph draft before dispatching work.');
  expect(result.text).toContain('Current requirement version: 3.');
  expect(result.text).not.toContain('<workflow>');
  expect(result.text).toContain('<docs>');
  expect(result.text).toContain('Graph documentation (read when the user asks about Graph itself');
  expect(result.text).toContain('- Main documentation: /app/docs/agent/README.md');
  expect(result.text).toContain('- Additional docs: /app/docs/agent');
  expect(result.text).toContain('- Examples: /app/examples');
  expect(result.text).toContain('resolve topic paths under Additional docs');
  expect(result.text).not.toContain('.graph/prompts/docs');
  expect(result.text).toContain('<project_context>');
  expect(result.text).toContain('<project_instructions path="/work/AGENTS.md">');
  expect(result.text).toContain('<capabilities>');
  expect(result.text).toContain('- mcp browser@1.2.0 (Browser): tools=browser_open; network=example.com');
  expect(result.text).toContain('<cwd>');
  // One working-directory block: the path line, then the worktree note. The Pi
  // process cwd is the same worktree, so a second block would only repeat it.
  expect(result.text).toContain('Current working directory: /home/me/.graph/state/worktrees/task-1/agent-a');
  expect(result.text).toContain("This directory is this operation's own Git worktree");
  expect(result.text).not.toContain('<pi_cwd>');
});

test('the worktree orientation note reaches subagents only', () => {
  const base = {
    identity: 'I am an Agent.',
    definitionVersion: 'main@1',
    toolGuidance: 'Use the tools you are given.',
    rules: { common: 'Be honest.', role: 'Role rules.' },
    docs: graphDocumentationPaths(),
    tools: [],
    capabilities: [],
  };
  const worktree = '/home/me/.graph/state/worktrees/task-1/agent-a';
  const main = composeAgentSystemPrompt({ ...base, role: 'main', cwd: worktree });
  const worker = composeAgentSystemPrompt({ ...base, role: 'worker', cwd: worktree });
  const noWorktree = composeAgentSystemPrompt({ ...base, role: 'worker' });

  // The main Agent already works in the project root; a subagent gets its own
  // worktree and has to be told that this is what it is looking at.
  expect(main.text).toContain(`Current working directory: ${worktree}`);
  expect(main.text).not.toContain('own Git worktree');
  expect(worker.text).toContain(`Current working directory: ${worktree}`);
  expect(worker.text).toContain('own Git worktree');
  expect(noWorktree.text).toContain('No worktree has been prepared for this conversation yet.');
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
