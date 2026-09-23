import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  DRAWER_DRAFT_PAGES,
  defaultDrawerOpen,
  defaultDrawerPage,
  drawerPageIds,
  drawerPanelIds,
  isDrawerPanel,
  isResidentPanel,
  panelPlacement,
  residentPanelIds,
} from '../../src/web/conversation-drawer.ts';

const read = (relative: string) => readFileSync(join(process.cwd(), relative), 'utf8');

/** Pure policy for the chat drawer: draft details + the task graph moved into
 * the right drawer and start collapsed, while the confirm and acceptance
 * entry points stay pinned to the main column. */

describe('drawer default state', () => {
  test('the drawer is collapsed by default', () => {
    expect(defaultDrawerOpen()).toBe(false);
    expect(defaultDrawerPage()).toBe('acceptance');
  });
});

describe('panel placement policy', () => {
  test('draft version history, acceptance, nodes, decisions and the task graph all live in the drawer', () => {
    for (const id of ['draft-versions', 'acceptance', 'nodes', 'decisions', 'graph']) {
      expect(drawerPanelIds()).toContain(id);
      expect(isDrawerPanel(id)).toBe(true);
      expect(panelPlacement(id)).toBe('drawer');
    }
    expect(DRAWER_DRAFT_PAGES.map(page => page.id)).toEqual(['acceptance', 'nodes', 'decisions', 'graph']);
    expect(drawerPageIds()).toContain('graph');
  });

  test('confirm / target branch / acceptance / questions stay visible in the main column', () => {
    for (const id of ['proposal-draft', 'draft-acceptance', 'draft-graph', 'accept-branch', 'confirm-draft', 'conversation-questions']) {
      expect(residentPanelIds()).toContain(id);
      expect(isResidentPanel(id)).toBe(true);
      expect(panelPlacement(id)).toBe('main');
    }
  });

  test('main and drawer panels are disjoint and unknown ids have no placement', () => {
    const main = new Set(residentPanelIds());
    for (const id of drawerPanelIds()) expect(main.has(id)).toBe(false);
    expect(panelPlacement('not-a-panel')).toBeNull();
    expect(isResidentPanel('graph')).toBe(false);
    expect(isDrawerPanel('confirm-draft')).toBe(false);
  });
});

describe('components genuinely use the policy module', () => {
  test('Conversation.tsx wires the drawer policy instead of hardcoding it', () => {
    const source = read('src/web/Conversation.tsx');
    expect(source).toContain("from './conversation-drawer.ts'");
    expect(source).toContain('drawerOpen = defaultDrawerOpen()');
    expect(source).toContain('useState<DrawerPage>(() => defaultDrawerPage())');
    expect(source).toContain('DRAWER_DRAFT_PAGES.map');
    expect(source).toContain('residentPanelIds().join');
    expect(source).toContain('drawerPanelIds().join');
    expect(source).toContain("data-resident={residentFlag('proposal-draft')}");
    expect(source).toContain("data-resident={residentFlag('confirm-draft')}");
    expect(source).toContain("data-resident={residentFlag('conversation-questions')}");
  });

  test('the drawer renders the draft pages plus the task graph, keeping their testids', () => {
    const source = read('src/web/Conversation.tsx');
    expect(source).toContain('data-testid="draft-page-tabs"');
    expect(source).toContain('data-testid={`draft-tab-${item.id}`}');
    expect(source).toContain('data-testid="draft-page-graph"');
    expect(source).toContain('data-testid="drawer-draft-toc"');
    expect(source).toContain('data-testid="conversation-graph"');
  });

  test('the main column keeps the draft entry points and their resident markers', () => {
    const source = read('src/web/Conversation.tsx');
    expect(source).toContain('data-testid="proposal-draft"');
    expect(source).toContain('data-testid="draft-graph"');
    expect(source).toContain('data-testid="draft-acceptance"');
    expect(source).toContain('data-testid="accept-branch"');
    expect(source).toContain('data-testid="confirm-draft"');
    // Questions are never moved behind the drawer.
    expect(source).toContain('data-testid={`conversation-questions-${task.id}`}');
  });
});
