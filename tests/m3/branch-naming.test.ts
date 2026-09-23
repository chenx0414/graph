import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import {
  MAX_SLUG_LENGTH, taskBranchName, taskShortId, taskSlug, taskWorktreeDirName, uniqueWorktreeDirName, workCopyBranchName,
} from '../../src/core/branch-naming.ts';
import { PINYIN_TABLE_SIZE, pinyinFor } from '../../src/core/pinyin-table.ts';

const source = (relativePath: string) => readFileSync(new URL(relativePath, import.meta.url), 'utf8');
const TASK_A = '0faf1367-1111-2222-3333-444455556666';
const TASK_B = '9b2c4d6e-aaaa-bbbb-cccc-ddddeeeeffff';

test('the built-in pinyin table is offline, non-trivial and maps the summary used by the acceptance case', () => {
  expect(PINYIN_TABLE_SIZE).toBeGreaterThan(400);
  for (const [char, expected] of [['修', 'xiu'], ['复', 'fu'], ['登', 'deng'], ['录', 'lu'], ['问', 'wen'], ['题', 'ti']] as const) {
    expect(pinyinFor(char), char).toBe(expected);
  }
  // Unknown characters are reported as such instead of silently becoming empty.
  expect(pinyinFor('龘')).toBeNull();
  expect(pinyinFor('A')).toBeNull();
});

test('a Chinese task summary becomes a readable toneless-pinyin slug', () => {
  expect(taskSlug('修复登录问题')).toBe('xiu-fu-deng-lu-wen-ti');
  expect(taskSlug('新增导出功能')).toBe('xin-zeng-dao-chu-gong-neng');
  expect(taskSlug('看板四态可视化')).toBe('kan-ban-si-tai-ke-shi-hua');
});

test('mixed Latin, digits, punctuation and unknown Han are folded predictably', () => {
  expect(taskSlug('Fix 修复 login 问题')).toBe('fix-xiu-fu-login-wen-ti');
  expect(taskSlug('v2 重构 API')).toBe('v2-zhong-gou-api');
  expect(taskSlug('修复  登录!!! 问题')).toBe('xiu-fu-deng-lu-wen-ti');
  // Untranslatable Han stays readable rather than dropping to nothing.
  expect(taskSlug('龘龘')).toBe('龘-龘');
  // Punctuation-only and empty summaries fall back to the default slug.
  expect(taskSlug('!!! ??? ...')).toBe('task');
  expect(taskSlug('   ')).toBe('task');
  expect(taskSlug('')).toBe('task');
});

test('slugs are branch-safe and bounded to the documented length', () => {
  const long = taskSlug('修复'.repeat(40));
  expect(long.length).toBeLessThanOrEqual(MAX_SLUG_LENGTH);
  expect(long.startsWith('xiu-fu')).toBe(true);
  expect(long.endsWith('-')).toBe(false);
  for (const summary of ['修复登录问题 Fix v2', '龘 龘 ~^:?*[\\', 'a'.repeat(80)]) {
    const slug = taskSlug(summary);
    expect(slug).not.toMatch(/[\s~^:?*\[\]\\]/);
    expect(slug).not.toContain('..');
    expect(slug.length).toBeLessThanOrEqual(MAX_SLUG_LENGTH);
    expect(slug.length).toBeGreaterThan(0);
  }
  // Same input always yields the same slug, and an already-slugified text is stable.
  expect(taskSlug('修复登录问题')).toBe(taskSlug('修复登录问题'));
  expect(taskSlug(taskSlug('修复登录问题'))).toBe(taskSlug('修复登录问题'));
});

test('the short id is the first eight compact characters of the task id', () => {
  expect(taskShortId(TASK_A)).toBe('0faf1367');
  expect(taskShortId('12345678-90ab-cdef-1234-567890abcdef')).toBe('12345678');
  expect(taskShortId('')).toBe('task');
});

test('branch and worktree names carry the pinyin slug plus the short id', () => {
  expect(taskBranchName('修复登录问题', TASK_A)).toBe('graph/task/xiu-fu-deng-lu-wen-ti-0faf1367');
  expect(workCopyBranchName('修复登录问题', TASK_A, 'impl-naming')).toBe('graph/copy/xiu-fu-deng-lu-wen-ti-0faf1367/impl-naming');
  expect(taskWorktreeDirName('修复登录问题', TASK_A)).toBe('xiu-fu-deng-lu-wen-ti-0faf1367');
  expect(taskWorktreeDirName('修复登录问题', TASK_A)).not.toContain('/');
  expect(taskBranchName('修复登录问题', TASK_A).startsWith('graph/task/')).toBe(true);
  expect(workCopyBranchName('修复登录问题', TASK_A, 'impl-naming').startsWith('graph/copy/')).toBe(true);
  expect(workCopyBranchName('修复登录问题', TASK_A, 'impl-naming')).toContain('/impl-naming');
});

test('the same summary on different tasks never collides', () => {
  const first = taskBranchName('修复登录问题', TASK_A);
  const second = taskBranchName('修复登录问题', TASK_B);
  expect(first).not.toBe(second);
  expect(first.endsWith('-0faf1367')).toBe(true);
  expect(second.endsWith('-9b2c4d6e')).toBe(true);
});

test('reused node directories are suffixed instead of overwritten', () => {
  expect(uniqueWorktreeDirName('impl-naming', [])).toBe('impl-naming');
  expect(uniqueWorktreeDirName('impl-naming', ['integration'])).toBe('impl-naming');
  expect(uniqueWorktreeDirName('impl-naming', ['impl-naming'])).toBe('impl-naming-2');
  expect(uniqueWorktreeDirName('impl-naming', ['impl-naming', 'impl-naming-2', 'impl-naming-3'])).toBe('impl-naming-4');
});

test('integration generates branch and directory names from the naming module', () => {
  const integration = source('../../src/git/integration.ts');
  // The bare uuid templates are gone: naming must flow through branch-naming.
  expect(integration).not.toContain('`graph/task/${taskId}`');
  expect(integration).not.toContain('`graph/copy/${taskId}/${nodeId}`');
  expect(integration).toContain("from '../core/branch-naming.ts'");
  expect(integration).toContain('taskBranchName(task.request, taskId)');
  expect(integration).toContain('taskWorktreeDirName(task.request, taskId)');
  expect(integration).toContain('workCopyBranchName(task.request, taskId, nodeId)');
});

test('no pinyin package (or any new dependency) was introduced', () => {
  const pkg = JSON.parse(source('../../package.json')) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  const names = [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})];
  expect(names.some(name => /pinyin/i.test(name))).toBe(false);
});
