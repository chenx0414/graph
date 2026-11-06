import { expect, test } from 'vitest';
import { toolActivity } from '../../src/web/tool-activity.ts';

test('shell activity distinguishes simple commands without disguising its executor', () => {
  expect(toolActivity('bash', 'rg needle src')).toMatchObject({ kind: 'search', name: 'bash · rg' });
  expect(toolActivity('bash', 'ls -la')).toMatchObject({ kind: 'list' });
  expect(toolActivity('bash', 'cat README.md')).toMatchObject({ kind: 'read' });
  expect(toolActivity('bash', 'ls; rm file')).toMatchObject({ kind: 'run', name: 'bash' });
  expect(toolActivity('read', '/repo/.agents/skills/debug/SKILL.md')).toMatchObject({ kind: 'skill', label: '读取 Skill' });
  expect(toolActivity('mcp__search__query')).toMatchObject({ kind: 'mcp' });
});

test('code mode has its own label and its own kind', () => {
  expect(toolActivity('codemode', "codemode: const r = await tools.ls({ path: '.' })")).toMatchObject({ kind: 'code', label: '代码模式' });
});
