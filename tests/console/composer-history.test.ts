import { describe, expect, test } from 'vitest';
import {
  createHistoryState,
  isNavigating,
  recallNewer,
  recallOlder,
  sentPrompts,
  shouldRecallHistory,
} from '../../src/web/chat-history.ts';

const history = ['第一条', '第二条', '第三条'];

describe('sent prompts', () => {
  test('keeps the user prompts oldest first', () => {
    expect(sentPrompts([
      { role: 'user', text: '第一条' },
      { role: 'assistant', text: '回复' },
      { role: 'user', text: '第二条' },
    ])).toEqual(['第一条', '第二条']);
  });

  test('ignores briefings, queued, cancelled and empty messages', () => {
    expect(sentPrompts([
      { role: 'user', kind: 'briefing', text: '任务说明' },
      { role: 'user', text: '真正发送' },
      { role: 'user', text: '排队中', state: 'queued' },
      { role: 'user', text: '已取消', state: 'cancelled' },
      { role: 'user', text: '   ' },
      { role: 'system', text: '系统' },
    ])).toEqual(['真正发送']);
  });

  test('folds an immediately repeated prompt into one entry', () => {
    expect(sentPrompts([
      { role: 'user', text: '再来一次' },
      { role: 'user', text: '再来一次' },
      { role: 'user', text: '换一个' },
    ])).toEqual(['再来一次', '换一个']);
  });
});

describe('which arrow keys recall history', () => {
  test('a single-line composer always recalls', () => {
    expect(shouldRecallHistory('older', '草稿', 2)).toBe(true);
    expect(shouldRecallHistory('newer', '', 0)).toBe(true);
  });

  test('in a multi-line draft only the boundary lines recall', () => {
    const value = '第一行\n第二行\n第三行';
    expect(shouldRecallHistory('older', value, 0)).toBe(true);
    expect(shouldRecallHistory('older', value, value.indexOf('\n'))).toBe(true);
    expect(shouldRecallHistory('older', value, value.length)).toBe(false);
    expect(shouldRecallHistory('newer', value, value.length)).toBe(true);
    expect(shouldRecallHistory('newer', value, 0)).toBe(false);
  });
});

describe('recall navigation', () => {
  test('the first ↑ remembers the draft and shows the newest prompt', () => {
    const first = recallOlder(createHistoryState(), history, '未发送的草稿')!;
    expect(first.value).toBe('第三条');
    expect(isNavigating(first.state)).toBe(true);
    expect(first.state.saved).toBe('未发送的草稿');
  });

  test('further ↑ walks to the oldest prompt and then stops', () => {
    let state = recallOlder(createHistoryState(), history, '草稿')!.state;
    const second = recallOlder(state, history, '草稿')!;
    expect(second.value).toBe('第二条');
    const third = recallOlder(second.state, history, '草稿')!;
    expect(third.value).toBe('第一条');
    expect(recallOlder(third.state, history, '草稿')).toBeNull();
  });

  test('↓ walks back and finally restores the draft', () => {
    let state = recallOlder(createHistoryState(), history, '未发送的草稿')!.state;
    state = recallOlder(state, history, '')!.state;   // 第二条
    const down = recallNewer(state, history)!;
    expect(down.value).toBe('第三条');
    expect(down.state.saved).toBe('未发送的草稿');
    const draft = recallNewer(down.state, history)!;
    expect(draft.value).toBe('未发送的草稿');
    expect(isNavigating(draft.state)).toBe(false);
  });

  test('↓ before any ↑ does nothing', () => {
    expect(recallNewer(createHistoryState(), history)).toBeNull();
  });

  test('an empty history never recalls', () => {
    expect(recallOlder(createHistoryState(), [], '草稿')).toBeNull();
  });
});
