import { describe, expect, it } from 'vitest';

/* Settings.tsx is a .tsx module; the NodeNext test program cannot compile TSX,
 * so vitest transpiles it and the web project typechecks it instead. */
// @ts-ignore -- .tsx import from a NodeNext test program
import { ADVANCED_SETTINGS, ADVANCED_SETTING_IDS, SETTINGS_SECTIONS, defaultAdvancedOpen, isAdvancedOpen } from '../../src/web/Settings.tsx';

type Section = { id: string; label: string };
type AdvancedSetting = {
  id: string;
  title: string;
  summary: string;
  fields: readonly string[];
  testIds: readonly string[];
  defaultCollapsed: boolean;
};

const SECTIONS = SETTINGS_SECTIONS as readonly Section[];
const ADVANCED = ADVANCED_SETTINGS as readonly AdvancedSetting[];
const ADVANCED_IDS = ADVANCED_SETTING_IDS as readonly string[];
const initialOpen = defaultAdvancedOpen as (settings?: readonly AdvancedSetting[]) => Record<string, boolean>;
const readOpen = isAdvancedOpen as (open: Record<string, boolean>, id: string) => boolean;

/**
 * B-0 settings-page tidy-up, asserted as pure data.
 *
 * The console tests must not render React or touch a DOM, so this file only
 * checks the exported section registry and the advanced-setting grouping that
 * `Settings.tsx` consumes. It intentionally says nothing about CSS classes or
 * the exact JSX of any card.
 */
describe('settings navigation sections (B-0)', () => {
  it('orders the sidebar as 通用/偏好 → 常规 → 模型 → 高级设置 → Git 准备 → 归档对话', () => {
    expect(SECTIONS.map(section => section.id)).toEqual([
      'settings-general',
      'settings-overview',
      'settings-models',
      'settings-advanced',
      'settings-git',
      'settings-archived',
    ]);
    expect(SECTIONS.map(section => section.label)).toEqual([
      '通用/偏好',
      '常规',
      '模型',
      '高级设置',
      'Git 准备',
      '归档对话',
    ]);
  });

  it('places 高级设置 after 模型 and before Git 准备', () => {
    const ids = SECTIONS.map(section => section.id);
    expect(ids.indexOf('settings-advanced')).toBeGreaterThan(ids.indexOf('settings-models'));
    expect(ids.indexOf('settings-advanced')).toBeLessThan(ids.indexOf('settings-git'));
  });

  it('keeps 并发限制 out of the top-level navigation', () => {
    expect(SECTIONS.map(section => section.label)).not.toContain('并发限制');
    expect(SECTIONS.map(section => section.id)).not.toContain('settings-limits');
  });

  it('groups the credential and shared-group concurrency limits under 高级设置', () => {
    expect(ADVANCED_IDS).toContain('settings-limits');
    const limits = ADVANCED.find(setting => setting.id === 'settings-limits');
    expect(limits).toBeDefined();
    expect(limits!.fields).toEqual(expect.arrayContaining(['limits.credentials', 'limits.sharedGroups']));
  });

  it('starts every advanced region collapsed', () => {
    expect(ADVANCED.length).toBeGreaterThan(0);
    expect(ADVANCED.every(setting => setting.defaultCollapsed)).toBe(true);
  });

  it('derives a default open-state that renders every advanced region closed', () => {
    const open = initialOpen();
    expect(open).toEqual({});
    for (const setting of ADVANCED) {
      expect(readOpen(open, setting.id)).toBe(false);
      expect(readOpen(open, setting.id)).toBeFalsy();
    }
  });

  it('reads an explicitly opened region from the controlled map', () => {
    expect(readOpen({ 'settings-limits': true }, 'settings-limits')).toBe(true);
    expect(readOpen({ 'settings-limits': false }, 'settings-limits')).toBe(false);
    expect(readOpen({}, 'settings-limits')).toBe(false);
  });

  it('keeps the existing concurrency-limit controls addressable', () => {
    const limits = ADVANCED.find(setting => setting.id === 'settings-limits');
    expect(limits!.testIds).toEqual(expect.arrayContaining([
      'limit-credential-add',
      'limit-group-add',
    ]));
  });
});
