import { expect, test } from 'vitest';
import { mendStreamingMarkdown, splitMarkdownBlocks } from '../../src/web/markdown-blocks.ts';
import { commonPrefixLength } from '../../src/web/use-stream-veils.ts';

test('markdown blocks preserve stable source ranges while the last block grows', () => {
  const first = splitMarkdownBlocks('# 标题\n\n第一段\n\n第二段');
  const second = splitMarkdownBlocks('# 标题\n\n第一段\n\n第二段继续');

  expect(first.map(block => block.source)).toEqual(['# 标题\n', '第一段\n', '第二段']);
  expect(second.slice(0, 2)).toMatchObject([
    { index: 0, source: '# 标题\n' },
    { index: 1, source: '第一段\n' },
  ]);
  expect(second[2]!.source).toBe('第二段继续');
});

test('streaming markdown mends hanging inline markers without changing settled text', () => {
  expect(mendStreamingMarkdown('已经结束')).toBe('已经结束');
  expect(mendStreamingMarkdown('**尚未完成')).toBe('**尚未完成**');
  expect(mendStreamingMarkdown('`code')).toBe('`code`');
  expect(mendStreamingMarkdown('[文档')).toBe('[文档](https://pending.invalid/)');
});

test('veil common prefix never re-fades already painted text', () => {
  expect(commonPrefixLength('第一段\n\n第二段', '第一段\n\n第二段继续')).toBe(8);
});
