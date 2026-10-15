# Baseline guard owner audit

Pinned baseline: 463fa2ca61157d10e4617c208a4684b1cd9744c9. Full suite: 271 files / 1852 cases, all passed (189.57 seconds), /tmp/graph-test-audit-baseline.json.

Owner: scripts/check-test-baseline.mjs; public entry: package.json check:baseline, called by check. History: 982997a added guard after unintentional suite shrink. Only test caller of compareBaseline: tests/m8/test-baseline-guard.test.ts. No non-test import callers for compareBaseline/readRunReport; exported helper API and .d.mts exist exclusively for tests.

All seven direct-helper declarations are C (consolidate into executable CLI E2E):
- B1 growth: keep higher-count report causes successful exit and actual baseline file rewrite.
- B1 unchanged: keep unchanged report successful exit and byte-identical baseline file.
- B2 fewer tests: keep lower tests rejects and preserves baseline.
- B2 fewer files alone: keep lower files rejects and preserves baseline (same rejection scenario exercises independent dimensions).
- B3 absent: keep first-run report writes real file and successful exit.
- B4 intentional lowering: keep GRAPH_UPDATE_BASELINE explicit option causes actual baseline lowering, message announces change.
- B5 malformed: keep invalid file contents rejects without rewriting.

Keepers BEFORE deletion: new tests/e2e/suite-baseline.test.ts runs byte-identical executable copied into isolated directory matching script's relative file layout; real OS child, real report/baseline IO, public env option, stdout/stderr and exit status. No private helper imports or mocked IO. Add missing-report CLI rejection (old direct-helper tests never exercised it); it catches absent test:report integration artifact.

Three primary workflow scenarios: initialization/growth/no-rewrite; dimension-specific shrink + explicit update; malformed/missing report rejection. Each assertion requires public observable behavior, not call shape. Risk: low, no algorithm changes. Remove test-only exports/declaration. Focused proof: node --run test -- tests/e2e/suite-baseline.test.ts tests/console/skills-lint.test.ts tests/m2/pre-push-hook.test.ts.
