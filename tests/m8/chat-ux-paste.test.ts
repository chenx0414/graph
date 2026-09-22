import { expect, test } from 'vitest';
import { insertAtCaret, readClipboardText } from '../../src/web/chat-paste.ts';

test('插入到 caret：无选区时把剪贴板文本插到光标处', () => {
  const result = insertAtCaret({ value: 'hello world', start: 5, end: 5, text: ' brave' });
  expect(result).toEqual({ value: 'hello brave world', caret: 11 });
});

test('有选区时替换选区，并把 caret 放到插入文本之后', () => {
  const result = insertAtCaret({ value: 'hello world', start: 6, end: 11, text: 'there' });
  expect(result).toEqual({ value: 'hello there', caret: 11 });
});

test('空剪贴板保持输入不变，caret 停在原地', () => {
  const result = insertAtCaret({ value: 'hello world', start: 5, end: 8, text: '' });
  expect(result).toEqual({ value: 'hello world', caret: 5 });
});

test('读取被拒或不可用时报告 blocked，而不是伪装成空剪贴板', async () => {
  await expect(readClipboardText(() => Promise.reject(new Error('denied')))).resolves.toEqual({ text: '', blocked: true });
  await expect(readClipboardText(() => Promise.reject('not allowed'))).resolves.toEqual({ text: '', blocked: true });
  await expect(readClipboardText(undefined)).resolves.toEqual({ text: '', blocked: true });
});

test('空剪贴板是空文本，不是权限问题', async () => {
  await expect(readClipboardText(() => Promise.resolve(''))).resolves.toEqual({ text: '', blocked: false });
});

test('读取成功时返回剪贴板纯文本', async () => {
  await expect(readClipboardText(() => Promise.resolve('粘贴内容'))).resolves.toEqual({ text: '粘贴内容', blocked: false });
});
