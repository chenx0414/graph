import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  BOARD_STATE_META,
  BOARD_STATE_ORDER,
  boardNodeState,
  boardStateCounts,
  boardStateKnown,
  boardStateLabel,
  boardUnknownCount,
  type BoardNodeState,
} from '../../src/web/insights.ts';

const read = (relative: string) => readFileSync(join(process.cwd(), relative), 'utf8');

/** Pure logic only: the four-state mapping and the source-level wiring. */

describe('boardNodeState four-state mapping', () => {
  const known: [string, BoardNodeState][] = [
    ['pending', 'pending'],
    ['draft', 'pending'],
    ['preparing', 'running'],
    ['running', 'running'],
    ['ready', 'running'],
    ['succeeded', 'done'],
    ['completed', 'done'],
    ['skipped', 'done'],
    ['blocked', 'blocked'],
    ['failed', 'blocked'],
  ];

  test('every existing status maps to its documented state', () => {
    for (const [status, expected] of known) {
      expect(boardNodeState(status), status).toBe(expected);
      expect(boardStateKnown(status), status).toBe(true);
    }
  });

  test('unknown statuses fall into 待执行 and are explicitly marked 未知', () => {
    for (const status of ['queued', 'paused', 'chatting', 'weird', '', 'ABANDONED']) {
      expect(boardNodeState(status)).toBe('pending');
      expect(boardStateKnown(status)).toBe(false);
      const label = boardStateLabel(status);
      expect(label.startsWith(BOARD_STATE_META.pending.label)).toBe(true);
      expect(label).toContain('未知');
    }
  });

  test('known labels do not carry the unknown marker', () => {
    expect(boardStateLabel('running')).toBe('运行中');
    expect(boardStateLabel('succeeded')).toBe('已完成');
    expect(boardStateLabel('failed')).toBe('被阻塞');
  });

  test('four states have distinct colours and icons and the expected labels', () => {
    const labels = BOARD_STATE_ORDER.map(state => BOARD_STATE_META[state].label);
    expect(labels).toEqual(['待执行', '运行中', '已完成', '被阻塞']);
    expect(new Set(BOARD_STATE_ORDER.map(state => BOARD_STATE_META[state].color)).size).toBe(4);
    expect(new Set(BOARD_STATE_ORDER.map(state => BOARD_STATE_META[state].icon)).size).toBe(4);
    for (const state of BOARD_STATE_ORDER) expect(BOARD_STATE_META[state].icon.length).toBeGreaterThan(0);
  });
});

describe('boardStateCounts legend', () => {
  test('always returns the four legend states in order, even with no nodes', () => {
    const counts = boardStateCounts([]);
    expect(counts.map(item => item.id)).toEqual(['pending', 'running', 'done', 'blocked']);
    expect(counts.every(item => item.count === 0)).toBe(true);
  });

  test('counts each node, folding unknown statuses into pending', () => {
    const counts = boardStateCounts(['pending', 'weird', 'ready', 'succeeded', 'skipped', 'failed']);
    const byId = Object.fromEntries(counts.map(item => [item.id, item.count]));
    expect(byId).toEqual({ pending: 2, running: 1, done: 2, blocked: 1 });
    expect(boardUnknownCount(['pending', 'weird', 'nope'])).toBe(2);
    expect(boardUnknownCount(['running', 'succeeded'])).toBe(0);
  });

  test('the legend keeps the state colour and icon for the four items', () => {
    const counts = boardStateCounts(['running']);
    for (const item of counts) {
      expect(item.color).toBe(BOARD_STATE_META[item.id].color);
      expect(item.icon).toBe(BOARD_STATE_META[item.id].icon);
      expect(item.label).toBe(BOARD_STATE_META[item.id].label);
    }
  });
});

describe('canvas and conversation source wiring', () => {
  test('node cards carry data-board-state and a state icon without dropping the readable label', () => {
    const source = read('src/web/GraphCanvas.tsx');
    expect(source).toContain('data-board-state={info.boardState}');
    expect(source).toContain('boardNodeState(node.status)');
    expect(source).toContain('node-state-icon');
    expect(source).toContain('BOARD_STATE_META[info.boardState].icon');
    // The original "id + name" text must survive next to the icon.
    expect(source).toContain('{info.label}');
    // Legacy semantics stay: data-status and data-tone are still emitted.
    expect(source).toContain('data-status={info.status}');
    expect(source).toContain('data-tone={info.tone}');
  });

  test('an unrecognised status gets a visible data-unknown badge on the card', () => {
    const source = read('src/web/GraphCanvas.tsx');
    expect(source).toContain('boardStateKnown(node.status)');
    expect(source).toContain('data-unknown="true"');
    expect(source).toContain('未知');
  });

  test('GraphCanvas itself renders the permanent four-item legend, so every task-graph view has it', () => {
    const canvas = read('src/web/GraphCanvas.tsx');
    expect(canvas).toContain('data-testid="legend"');
    expect(canvas).toContain('boardStateCounts(statuses)');
    expect(canvas).toContain('data-board-state={item.id}');
    expect(canvas).toContain('含未知');
    // The old five-tier legend on the task page is gone.
    const app = read('src/web/App.tsx');
    expect(app).not.toContain('data-testid="legend"');
    expect(app).not.toContain('待执行 / 就绪');
    expect(app).not.toContain('被阻塞 / 已跳过');
  });

  test('the conversation drawer keeps the task-graph testids without a second legend', () => {
    const source = read('src/web/Conversation.tsx');
    expect(source).toContain('data-testid="graph-state-summary"');
    expect(source).toContain('data-testid="draft-graph-detail"');
    expect(source).toContain('data-testid="conversation-node-detail"');
    // The legend is single-sourced in GraphCanvas; the drawer must not render
    // its own copy under a different testid.
    expect(source).not.toContain('graph-board-legend');
  });
});
