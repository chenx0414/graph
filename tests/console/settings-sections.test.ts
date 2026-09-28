import { describe, expect, it } from 'vitest';

/* Settings.tsx is a .tsx module; the NodeNext test program cannot compile TSX,
 * so vitest transpiles it and the web project typechecks it instead. */
// @ts-ignore -- .tsx import from a NodeNext test program
import { ADVANCED_SETTINGS, ADVANCED_SETTING_IDS, SETTINGS_SECTIONS, defaultAdvancedOpen, isAdvancedOpen } from '../../src/web/Settings.tsx';
import { concurrencyControlIds } from '../../src/web/provider-form.ts';

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

const SAMPLE: readonly AdvancedSetting[] = [
  { id: 'settings-sample', title: '示例', summary: '示例说明', fields: ['sample.field'], testIds: ['sample-control'], defaultCollapsed: true },
];

/**
 * B-0 settings-page tidy-up, re-encoded for B-1.
 *
 * B-0 grouped the concurrency caps into a collapsed 高级设置 region. B-1 moved
 * both caps inside the ① 配置厂商 card and removed that region, so the registry
 * is intentionally empty and this file asserts the new contract instead: the caps
 * are addressable through the derived inline ids and no top-level page claims
 * them. The console tests must not render React or touch a DOM, so everything
 * here is pure data and pure helpers.
 */
describe('settings navigation sections (B-0/B-1)', () => {
  it('keeps only general settings and archived conversations in the settings sidebar', () => {
    expect(SECTIONS.map(section => section.id)).toEqual([
      'settings-overview',
      'settings-archived',
    ]);
    expect(SECTIONS.map(section => section.label)).toEqual([
      '常规',
      '归档对话',
    ]);
  });

  it('keeps 并发限制 out of the top-level navigation', () => {
    expect(SECTIONS.map(section => section.label)).not.toContain('并发限制');
    expect(SECTIONS.map(section => section.id)).not.toContain('settings-limits');
  });

  it('no longer groups the concurrency caps under 高级设置 (B-1 moved them inline)', () => {
    expect(ADVANCED_IDS).not.toContain('settings-limits');
    expect(ADVANCED).toEqual([]);
  });

  it('derives the inline concurrency controls of one credential', () => {
    expect(concurrencyControlIds('local')).toEqual({
      credential: 'limit-credential-local',
      groupId: 'limit-group-id-local',
      groupLimit: 'limit-group-local',
    });
    expect(Object.values(concurrencyControlIds('second'))).toEqual([
      'limit-credential-second',
      'limit-group-id-second',
      'limit-group-second',
    ]);
  });

  it('starts every advanced region collapsed', () => {
    expect(SAMPLE.length).toBeGreaterThan(0);
    expect(SAMPLE.every(setting => setting.defaultCollapsed)).toBe(true);
    expect(initialOpen(SAMPLE)).toEqual({});
  });

  it('derives a default open-state that renders every advanced region closed', () => {
    const open = initialOpen(SAMPLE);
    for (const setting of SAMPLE) {
      expect(readOpen(open, setting.id)).toBe(false);
      expect(readOpen(open, setting.id)).toBeFalsy();
    }
  });

  it('reads an explicitly opened region from the controlled map', () => {
    expect(readOpen({ 'settings-sample': true }, 'settings-sample')).toBe(true);
    expect(readOpen({ 'settings-sample': false }, 'settings-sample')).toBe(false);
    expect(readOpen({}, 'settings-sample')).toBe(false);
  });
});
