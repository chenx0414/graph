# Usage provenance audit 42 — read-only plan

Scope: current `tests/console/usage-source.test.ts` (2 declarations, fully read), `src/runtime/controlled-openai.ts` (entire file), Pi adapter option plus all 3 stream call sites, its sole production constructor in `task-runtime`, resident-worker and kernel-graph-lane stream entry points, entire call-broker/task-gate/kernel-provider-gate, operation-lifecycle normalization/summation/settlement, node-run and kernel-view provenance projections. Read `CONTEXT.md`, ADR0017, test-audit skill/CAMPAIGN/reference, CODING_STANDARDS and tests/AGENTS. Read full keepers `tests/e2e/conversation-runtime.test.ts`, `tests/m8/kernel-node-budget.test.ts`, `tests/e2e/node-budget.test.ts`. No repo edits and no Vitest runs performed; root's full39 checkout freeze honored.

## History and callers

- `87712d0` introduced provenance, all four persisted labels, local estimation, and optional account delta hook. Historical original test already fabricated account-delta 7/3/1/0 by direct option injection. No account provider implementation existed in that commit's Pi wiring.
- `c8011f7` fixed OpenAI `[DONE]` and Anthropic `message_stop` completion independent of socket EOF. It added the old direct stream probe and a native main tool-use regression in the same commit. The native regression survives now in conversation-runtime's second declaration.
- Whole-tree `accountUsageDelta` search (excluding generated planning copies) finds only the controlled stream declaration/implementation; Pi option and 3 forwards; and the old test callback. `createPiAdapter` has exactly one production constructor caller, `src/core/task-runtime.ts:512`; it supplies no account callback, and openTaskRuntime exposes no routing for it. All native graph stream calls and resident-worker stream calls also supply none. Therefore the callback is currently unreachable through actual application entry points. Existing `account_delta` *read/merge* semantics are not dead.
- Controlled stream actual callers: Pi main, prompt suggestion, sediment review; native kernel graph lane; resident-worker direct/spike fallback. All still need onSend, estimateMissing and the actual controlled stream.

## Declaration ledger

| Declaration | Mark | Detectable failure and primary keeper | Carry before retirement |
| --- | --- | --- | --- |
| `a completed SSE response settles before the provider closes its connection` | C | A valid OpenAI terminal frame on a still-open socket must release/settle so real main progresses. Primary owner: conversation-runtime `a tool-use response that keeps SSE open does not stall the following turn`, using the same external fixture's `holdOpen: true`, actual Pi/main tools, real persistence and follow-up reply. This catches a transport that waits for EOF. | Add public nodeRun invocation assertion for that held response's authoritative counts (input128/output256/cacheRead0/cacheWrite0). Existing main keeper currently checks reply completion and not-dispatched, but not the exact persisted source/count. Default 30s suite bound is the hang guard; do not preserve the arbitrary old 1000ms performance deadline as a product SLA. |
| `usage provenance prefers provider, then account delta, then local estimation` | C/D by row | Provider row C: authoritative tagging/count comes from real main and native budget keepers (e.g. main-budget exact authoritative input20000); add held-source carry above. Estimate row C: kernel-node-budget first genuine native test checks two real provider calls, both estimated/nonzero counts, actual tool file result and successful unlimited node, plus separate finite no-count unknown/blocked refusal. Fake account delta row D: only a direct injected callback supplies the asserted values; no configured subscription adapter or public path exists. | No new callback-based E2E or fixture-supplied usage receipts. Retire the dead account hook with this row. Preserve the source enum/read/merge and all historical projections. |

Important limit: the old test title overstates priority. Its authoritative call supplies **no** account callback, and its account callback runs only on a response deliberately lacking provider usage. Thus it never proves `provider > account delta` in a conflict. Do not report loss or preservation of a never-tested priority guard.

## Layer plan

1. Extend existing native main held-SSE keeper with persisted invocation evidence. Example after its current completed view assertions:

```ts
expect(runtime.nodeRun(created.taskId, 'main').invocations.filter(call => call.usage?.output === 256)).toMatchObject([{
  usageSource: 'authoritative',
  usage: { input: 128, output: 256, cacheRead: 0, cacheWrite: 0 },
}]);
```

The fixture has a unique output256 response. `toMatchObject` on array also enforces exactly one matching invocation; the runtime owner writes it. Confirm current nodeRun main DTO exposes these fields; inspected node-run maps persisted invocations with `usage` + `usageSource`. No direct SQL or gate injection needed.

2. Run existing real keepers together: `pnpm exec vitest run tests/e2e/conversation-runtime.test.ts tests/m8/kernel-node-budget.test.ts tests/e2e/main-budget.test.ts tests/e2e/node-budget.test.ts tests/console/unlimited.test.ts`. Root should append current Anthropic transport owner sibling as appropriate; that protocol shares completion/clone machinery and must stay intact.
3. Mutation controls on the same real keepers: temporarily change OpenAI authoritative output count or source in parseUsage and ensure held-SSE persisted assertion fails on intended field; restore byte for byte. Temporarily prevent OpenAI semantic terminal recognition in both bounded body and raw evidence reader to prove actual held flow times out/stalls; do not accept SDK error or unrelated fixture failure as proof. Existing estimated keeper should reject replacing estimated source with authoritative (intended usageSource assertion).
4. Delete old usage-source file (90 LOC) once carry and controls pass; do not reclassify it as E2E. Remove unreachable hook as exact fragments below. Route/manifest update unnecessary for existing E2E file path; update any recorded content hash if root's runtime inventory uses it.
5. Run post-removal owner/sibling proof, typecheck and diff checks. No claims that full39 covers these later edits.

## Exact production deletion boundary

`/tmp/graph-usage-source42-fragments.json` provides 12 ordered exact old/new fragments with current source SHA256. It removes:
- AccountUsageDeltaInput type;
- callback property/comment in ControlledStreamUsageOptions;
- account-only optional response clone and both cancellation sites;
- callback branch + manufactured `usageSource: account_delta` producer;
- createPiAdapter never-supplied option, its imported type, and all three forwards;
- estimateMissing comment now describes only the surviving actual per-request fallback.

Keep `ControlledStreamUsageOptions` itself exported for controlled stream signature and keep onSend/estimateMissing untouched. The imported `type Context` in controlled-openai is already unused (only declaration is import); can separately remove if normal cleanup permits, but not caused by this hook retirement and not needed for correct deletion.

**Must not delete:** UsageSource `account_delta`, USAGE_SOURCES, usageSourceOf normalization of legacy absent field to authoritative, mergeUsageSource account_delta precedence, taskGate total normalization/merging/accountable support, combineKnownUsage and operation-lifecycle summation, legacy and native nodeRun provenance projections, reconciliation count readers, existing DB schema/records. These implement existing ADR0017 compatibility and still have production consumers. No writable schema migration is implied. There is no current genuine account-delta producer to add E2E for; if a real subscription adapter is introduced later it must supply attributable data through an actual production entry and own new boundary proof.

## Risks and limitations

- ADR0017 describes account-delta as an intended model integration strategy. Removing an unreachable extension seam does not implement that strategy; record future provider integration as follow-up rather than silently rewriting ADR/domain language. Current app behavior remains provider -> permitted estimate -> unknown.
- No standalone historical account_delta recovery fixture exists in current tests (only old fake callback row matches the literal). Therefore this audit cannot claim historical read compatibility is newly E2E-proven. Preserve its existing production code exactly; do not fake an account meter or mutate actual writer receipts and call it an account-origin E2E.
- Direct old settled length=1 was mock-gate call shape. Genuine persisted matching invocation and downstream completion are the user contract. Existing full real native ledger keeper charges once and leaves idle drive usage unchanged; no duplicate lower-layer proof is needed.
- This is a read-only proposal. Candidate/full/typecheck/mutation results remain root work, not evidence supplied by this audit.

Exact fragments dry-applied in memory only: all unique matches. src/runtime/controlled-openai.ts: net removed 31 lines; account hook remains False; src/runtime/pi-adapter.ts: net removed 5 lines; account hook remains False. Source files were not modified.
