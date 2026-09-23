import { expect, test } from 'vitest';

/* ResourceLibrary is a .tsx module; the NodeNext test program cannot compile
 * TSX, so vitest transpiles it and the web project typechecks it instead. */
// @ts-ignore -- .tsx import from a NodeNext test program
import { LIBRARY_FILTERS, capabilityConfigGuidance, capabilityIsConfigured, splitLibraryEntries } from '../../src/web/ResourceLibrary.tsx';

type Filter = 'all' | 'configured' | 'unconfigured';

function record(id: string, status: 'available' | 'invalid' = 'available') {
  return { id, version: '1.0.0', kind: 'skill' as const, source: `/tmp/${id}`, snapshot: {}, status };
}

function config(id: string, ready: boolean, missing: string[] = []) {
  return {
    id,
    version: '1.0.0',
    name: id,
    kind: 'skill' as const,
    source: `/tmp/${id}`,
    fields: [],
    configured: ready ? missing : [],
    missing,
    ready,
  };
}

const FILTERS: readonly Filter[] = ['all', 'configured', 'unconfigured'];

test('the filter control lists all / configured / unconfigured in order', () => {
  expect(LIBRARY_FILTERS.map((option: { id: string }) => option.id)).toEqual([...FILTERS]);
  expect(LIBRARY_FILTERS.map((option: { label: string }) => option.label)).toEqual(['全部', '已配置', '未配置']);
});

test('an empty library has zero counts and no visible entries for every filter', () => {
  for (const filter of FILTERS) {
    const split = splitLibraryEntries([], filter, () => true);
    expect(split.configured).toEqual([]);
    expect(split.unconfigured).toEqual([]);
    expect(split.visible).toEqual([]);
    expect(split.counts).toEqual({ all: 0, configured: 0, unconfigured: 0 });
  }
});

test('a fully configured library keeps every entry in the configured group', () => {
  const entries = [record('a'), record('b')];
  const split = splitLibraryEntries(entries, 'all', () => true);
  expect(split.configured.map((entry: { id: string }) => entry.id)).toEqual(['a', 'b']);
  expect(split.unconfigured).toEqual([]);
  expect(split.counts).toEqual({ all: 2, configured: 2, unconfigured: 0 });
});

test('a fully unconfigured library keeps every entry in the unconfigured group', () => {
  const entries = [record('a'), record('b')];
  const split = splitLibraryEntries(entries, 'all', () => false);
  expect(split.configured).toEqual([]);
  expect(split.unconfigured.map((entry: { id: string }) => entry.id)).toEqual(['a', 'b']);
  expect(split.counts).toEqual({ all: 2, configured: 0, unconfigured: 2 });
});

test('mixed entries split by configured state and the filter selects one group', () => {
  const entries = [record('s1'), record('m1'), record('s2'), record('m2')];
  const ready = new Set(['s1', 's2']);
  const isConfigured = (entry: { id: string }) => ready.has(entry.id);

  const all = splitLibraryEntries(entries, 'all', isConfigured);
  expect(all.configured.map((entry: { id: string }) => entry.id)).toEqual(['s1', 's2']);
  expect(all.unconfigured.map((entry: { id: string }) => entry.id)).toEqual(['m1', 'm2']);
  expect(all.counts).toEqual({ all: 4, configured: 2, unconfigured: 2 });
  expect(all.visible.map((entry: { id: string }) => entry.id)).toEqual(['s1', 's2', 'm1', 'm2']);

  const configuredOnly = splitLibraryEntries(entries, 'configured', isConfigured);
  expect(configuredOnly.visible.map((entry: { id: string }) => entry.id)).toEqual(['s1', 's2']);
  expect(configuredOnly.counts).toEqual({ all: 4, configured: 2, unconfigured: 2 });

  const unconfiguredOnly = splitLibraryEntries(entries, 'unconfigured', isConfigured);
  expect(unconfiguredOnly.visible.map((entry: { id: string }) => entry.id)).toEqual(['m1', 'm2']);
});

test('configured state follows manifest readability and missing fields', () => {
  expect(capabilityIsConfigured(record('plain'))).toBe(true);
  expect(capabilityIsConfigured(record('needs-key'), config('needs-key', true))).toBe(true);
  expect(capabilityIsConfigured(record('needs-key'), config('needs-key', false, ['EXA_API_KEY']))).toBe(false);
  expect(capabilityIsConfigured(record('broken', 'invalid'))).toBe(false);
});

test('unconfigured entries carry a one-line how-to-configure hint', () => {
  const guidance = capabilityConfigGuidance(record('needs-key'), config('needs-key', false, ['EXA_API_KEY', 'EXA_URL']));
  expect(guidance).toContain('EXA_API_KEY');
  expect(guidance).toContain('EXA_URL');
  expect(guidance).toContain('环境变量');
  expect(guidance).toContain('设置页');

  expect(capabilityConfigGuidance(record('broken', 'invalid'))).toContain('清单不可读');
  expect(capabilityConfigGuidance(record('ok'), config('ok', true))).toBe('');
});
