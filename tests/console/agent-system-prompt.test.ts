import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { openAgentContextLibrary } from '../../src/runtime/agent-context.ts';
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
    definitionVersion: 'main@7',
    toolGuidance: 'Use the smallest tool that can prove the claim.',
    rules: {
      common: 'Common rule.',
      role: 'Submit a graph draft before dispatching work.',
      runtime: 'Current requirement version: 3.',
    },
    docs: {
      root: '/home/me/.graph/prompts/docs',
      index: 'Read docs/INDEX.md before discussing Graph internals.',
    },
    projectContext: {
      path: '/work/AGENTS.md',
      content: 'Keep project-specific conventions.',
    },
    tools: [{
      name: 'read',
      description: 'Read a file.',
      source: 'Graph',
      parameters: ['path'],
      permission: 'workspace read',
      available: true,
    }],
    capabilities: [{
      id: 'browser',
      version: '1.2.0',
      kind: 'mcp',
      name: 'Browser',
      tools: ['browser_open'],
      networkDomains: ['example.com'],
    }],
    cwd: '/home/me/.graph/state/worktrees/task-1/agent-a',
    piCwd: '/home/me/.graph/state/worktrees/task-1/agent-a',
  });

  expect(result.sections.map(section => section.id)).toEqual([
    'identity',
    'tools',
    'rules',
    'workflow',
    'docs',
    'project_context',
    'capabilities',
    'cwd',
  ]);
  expect(result.sections.find(section => section.id === 'tools')?.parts.map(part => part.origin))
    .toEqual(['editable', 'generated']);
  expect(result.text).toContain('<identity>\nYou are the Main Agent.\n</identity>');
  expect(result.text).toContain('<tools>');
  expect(result.text).toContain('Use the smallest tool that can prove the claim.');
  expect(result.text).toContain('- read (Graph; workspace read; parameters: path): Read a file.');
  expect(result.text).toContain('<rules>');
  expect(result.text).toContain('Common rule.');
  expect(result.text).toContain('Submit a graph draft before dispatching work.');
  expect(result.text.match(/<rules>\n([\s\S]*?)\n<\/rules>/)?.[1]).not.toContain('Current requirement version: 3.');
  expect(result.text).toContain('<workflow>');
  expect(result.text).toContain('Current requirement version: 3.');
  expect(result.text).toContain('<docs>');
  expect(result.text).toContain('/home/me/.graph/prompts/docs');
  expect(result.text).toContain('<project_context>');
  expect(result.text).toContain('<project_instructions path="/work/AGENTS.md">');
  expect(result.text).toContain('<capabilities>');
  expect(result.text).toContain('- mcp browser@1.2.0 (Browser): tools=browser_open; network=example.com');
  expect(result.text).toContain('<cwd>');
  expect(result.text).toContain('/home/me/.graph/state/worktrees/task-1/agent-a');
  expect(result.text).not.toContain('<pi_cwd>');
  expect(result.previewSections.at(-1)).toMatchObject({
    id: 'pi_cwd',
    parts: [{ origin: 'pi', content: 'Current working directory: /home/me/.graph/state/worktrees/task-1/agent-a' }],
  });
  expect(result.previewText).toContain('<pi_cwd>');
});

test('the Agent context library seeds rules, tool guidance and docs and can restore defaults', async () => {
  const root = await temp();
  const library = openAgentContextLibrary(root, {
    identity: 'Original identity',
    docs: { 'docs/INDEX.md': '# Original index\n\nRead the topic files.' },
  });
  await library.ensure();

  expect(await readFile(join(root, 'rules/common.md'), 'utf8')).toContain('tool results');
  expect(await readFile(join(root, 'tools/main.md'), 'utf8')).toContain('tools');
  expect(await readFile(join(root, 'docs/INDEX.md'), 'utf8')).toBe('# Original index\n\nRead the topic files.\n');

  await library.savePrompt('rules/common.md', 'Changed common rule.');
  expect(await library.prompt('rules/common.md')).toBe('Changed common rule.');

  await library.resetPrompt('rules/common.md');
  expect(await library.prompt('rules/common.md')).toContain('tool results');
});
