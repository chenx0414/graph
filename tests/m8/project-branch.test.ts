import { expect, test } from 'vitest';
import { defaultTargetBranch } from '../../src/web/project-branch.ts';

test('新任务默认指向项目当前分支，而不是写死的 main', () => {
  expect(defaultTargetBranch([{ id: '13-Graph', branch: 'feat/app-ux' }], '13-Graph')).toBe('feat/app-ux');
});

test('没有实时分支时回落到准备记录里的分支', () => {
  expect(defaultTargetBranch([{ id: 'p', preparation: { branch: 'develop' } }], 'p')).toBe('develop');
});

test('没有可信分支时返回 null，由界面保留兜底值', () => {
  expect(defaultTargetBranch(undefined, 'p')).toBeNull();
  expect(defaultTargetBranch([{ id: 'p', branch: '   ' }], 'p')).toBeNull();
  expect(defaultTargetBranch([{ id: 'p', branch: 'main' }], null)).toBeNull();
});
