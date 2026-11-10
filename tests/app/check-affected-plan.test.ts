import { describe, expect, test } from 'vitest';
import { selectCheckPlan } from '../../scripts/check-affected-plan.mjs';

const existsEverywhere = () => true;
const deleted = () => false;

describe('check:affected plan', () => {
  test('runs a changed leaf test that still exists, and nothing else', () => {
    const plan = selectCheckPlan({ changed: ['tests/m8/drawer-section-ui.test.ts'], exists: existsEverywhere });
    expect(plan.files).toEqual(['tests/m8/drawer-section-ui.test.ts']);
    expect(plan.label).toBe('1 changed leaf test(s)');
  });

  test('a deleted leaf test never becomes the run, because it can assert nothing', () => {
    const plan = selectCheckPlan({ changed: ['tests/e2e/agent-rule-seed.test.ts'], exists: deleted });
    expect(plan.files).toEqual(['tests/console', 'tests/app', 'tests/m7']);
    expect(plan.label).toBe('pure layers');
  });

  test('a backend change with a deleted leaf test still covers the in-process layers', () => {
    const plan = selectCheckPlan({ changed: ['src/web/app.tsx', 'tests/e2e/gone.test.ts'], exists: path => path !== 'tests/e2e/gone.test.ts' });
    expect(plan.files).toEqual(['tests/console', 'tests/app', 'tests/m7']);
  });

  test('a store change keeps the schema keeper and adds a surviving leaf test', () => {
    const plan = selectCheckPlan({ changed: ['backend/internal/graph/core_store.go', 'tests/m8/drawer-section-ui.test.ts'], exists: existsEverywhere });
    expect(plan.files).toContain('tests/e2e/go-schema-upgrade.test.ts');
    expect(plan.files).toContain('tests/m8/drawer-section-ui.test.ts');
  });
});
