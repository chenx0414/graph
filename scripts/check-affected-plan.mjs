import { existsSync } from 'node:fs';

export const WEB = ['src/web/', 'src/core/', 'desktop/'];
export const STORE = /^backend\/internal\/graph\/core_store/;
export const STORE_KEEPER = 'tests/e2e/go-schema-upgrade.test.ts';
const IN_PROCESS = ['tests/console', 'tests/app', 'tests/m7', 'tests/m8'];
const IN_PROCESS_OFFLINE = ['tests/console', 'tests/app', 'tests/m7'];
const LEAF = /^tests\/[^/]+\/[^/]+\.test\.ts$/;

export function selectCheckPlan({ changed, exists = existsSync, forced = false, storeKeeper = STORE_KEEPER }) {
  const leafTests = changed.filter(path => LEAF.test(path) && exists(path));
  const web = changed.some(path => WEB.some(prefix => path.startsWith(prefix)));
  const store = changed.some(path => STORE.test(path));
  if (forced) return { label: 'forced full (CI)', files: [] };
  if (store) {
    return {
      label: leafTests.length ? `schema keeper + ${leafTests.length} changed leaf test(s)` : 'schema upgrade keeper',
      files: [...new Set([storeKeeper, ...leafTests])],
    };
  }
  if (leafTests.length) return { label: `${leafTests.length} changed leaf test(s)`, files: leafTests };
  return web
    ? { label: 'in-process layers', files: IN_PROCESS }
    : { label: 'pure layers', files: IN_PROCESS_OFFLINE };
}
