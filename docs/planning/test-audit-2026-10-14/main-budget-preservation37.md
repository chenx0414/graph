# Main budget preservation review 37 (independent, read-only)

Read complete current tests/e2e/main-budget.test.ts, all three original console/budget-ledger.test.ts declarations and fixtures, /tmp/graph-legacy-budget-plan37.md, entire core/budget-ledger.ts and core/context.ts; traced task-gate check/dispatch/settle, execution model selection + initial reservation, lifecycle interrupt/success commit/release, user setBudget and conversations.selectModel, and ADR0014/0030. No repository edits or Vitest execution performed by reviewer.

## Decision after root's explicit clarification

Eligible old declarations to retire after restored passing candidate/control:
- `unlimited and model history remain explicit ledger facts` (old declaration 2).
- `in-flight invocation usage is counted before settlement without becoming committed usage` (old declaration 3).

KEEP old declaration 1 `one scope owns reservation, commit and shared cap changes` and its fixture until a genuine restored historical multi-member installation/public owner workflow replaces its compatibility proof. Do not claim the one-member new main scope proves multi-member owner authority, shared reservation, shared cap increments or synchronized child instance budgets. Root confirms this preservation decision and is adding exact-limit2052256 positive to new matrix. This report approves a two-declaration cutover, not blanket removal of the old file.

`shareBudgetScope` is implementation dead with zero production callers, but the retained first old declaration remains its current test caller. Therefore do NOT delete that function as part of this partial two-declaration retirement. Once the first declaration is replaced by a provenance-backed historical installation fixture, the helper can be removed if still no production callers. Do not remove stored shared format/columns, active ownership check, aggregate arithmetic, or addBudget merely because new public forks are retired.

## Genuine E2E classification

Yes: new whole file drives actual public runtime/conversation/user-budget APIs and host.drive, actual Pi/native process and SDK, fixture-owned loopback external providers, actual on-disk project read, actual persisted invocation and operation writers, actual runtime close/reopen, and public nodeRun projections. The only upstream fixture controls remote provider replies/authoritative usage and response timing; it does not fabricate Graph instances, invocations, receipts, reservations, ordering or budget scopes. standardAccessPolicy is intentional: fullAccess would bypass main budget guard and invalidate the test. `mainRun` is assertion/read convenience, not a production seam.

In-flight positive row proves actual second main provider send exists, actual tool response contains project sentinel, actual first authoritative20000 usage has been durably recorded while operation remains dispatched/reserved2M and both instance/scope committed used remain0. Holding upstream beforeReply is a genuine transport boundary, not fake owner state. Settlement observes20050 and reservation0. Negative row proves exactly one real provider send, genuine budget guard interruption and visible reason/question, preserves20000 billed tokens and releases reservation. It cannot pass merely because tool never executes in both rows: positive real second send includes the independently written sentinel.

History case actual first main50 plus actual prompt-suggestion cheap3 gives53; each next actual turn adds53, yielding106 and159. This correctly supersedes original plan's naïve50/100/150 rather than changing expected values to match unknown observed state: fixture explicitly declares independent authoritative40+10 and2+1 token replies, checks1+2 main requests and3cheap requests. Same owner main ledger intentionally includes these billed auxiliary sends. It asserts main modelsUsed first/next ordered once, not cheap, consistent with execution identity history (selection/instance model) distinct from billed invocation ledger.

Before/after public selectModel and user setBudget, stable instance/scope id and usage53 are read. Close/reopen of exact state reads same identities, capnull/unlimitedtrue and modelhistory first. Actual next provider request includes prior `First model reply.` history after reopen, so session continuity is not inferred solely from stored scalar IDs. Two actual next requests extend history once and accumulate usage to159, final conversation reply real. This is adequate full-runtime E2E; browser/HTTP wrapper would add no distinct budget-owner contract.

## Exact original contract mapping

### Original declaration 2 — retire

- recordModelUse m1/m2/m2 order/dedup -> actual first model execution, public selectModel, close/reopen, two actual next model turns, public modelsUsed=['first','next'] after each. New literal history assertions catch missing selection recording and duplicate appends.
- commitUsage(0) leaves used/scopeUsed0 -> this exact helper call is an internal no-op, not independently executable product command. New in-flight keeper protects genuine zero-committed initial state and positive settlement; current source commitUsage total>0 branch has no externally visible mutation at0. No need fabricate a zero-return receipt to preserve private call identity. Do not remove production zero guard.
- setBudget null -> public user.task(taskId).setBudget(master,null), public instance budgetnull/unlimitedtrue and scope.limitnull/unlimitedtrue, same identity/used before and after reopen.
- unlimited budget admission -> actual further main SDK calls succeed under unlimited after switch and restart. Scope cap null is not merely decorative: assertWithinBudget must return before treating null finite cap as0. Current newkeeper catches a removed unlimited guard through real dispatch failure.

### Original declaration 3 — retire after exact-limit carry/control

- first in-flight authoritative usage is billable before commit -> actual20000 invocation recorded during real operation but committed counters0, as above.
- next send admission includes pending invocation + outstanding op reservation -> fixed independent fixture constants:2000000 +20000 +32256 =2052256. Original current root rows2050000 rejects and2060000 permits bracket threshold but do NOT prove equality allowed. Root is adding2052256 positive, which directly preserves original20 allowed/21 denied semantic boundary.
- release outstanding reserve, commit exactly once -> positive/negative both final public reserved0 and exact20050/20000 counters. Operation states actual succeeded/interrupted, inactive; no repeated private commit calls.
- required control: remove scopeInFlightUsage from owner sum;2050000 row must wrongly send second request and fail intended guard/request-count. The equality positive should also catch changing `total > cap` to `total >= cap` when reservation>0. Restore owner byte-for-byte and rerun candidate.

### Original declaration 1 — KEEP remaining compatibility contract

Observed genuine new main members1 is not a proof of:
- joined scope has members2 and shared owner source;
- sibling sees source outstanding reservation;
- sibling sees source committed usage and exact remaining allowance;
- nonowner cannot set shared cap (`shared_budget_owner_required`);
- child addBudget increments source+child caps consistently, scope cap and exact admission boundary.

New public context creation resolves only main fresh/continue; explicit legacy context rejected and freeze rejects inherited modes, so there is no current public product path that creates the original new fork instance and calls shareBudgetScope. That establishes unused creation helper, NOT deletion of already stored compatibility semantics. budget-ledger still actively reads/mutates multi-member histories, and partial campaign explicitly keeps them. Neither ADR0030 nor absence of a new fork creator is evidence to remove the last stored-format owner test while code intentionally retains support.

The repeated ensureBudgetScope idempotence and single-scope view/commit/reservation facts are partly covered by stable real main/restart IDs, but they do not absorb the complete declaration. Retain the whole declaration now; do not split away checks merely for count. Future coherent migration should use genuine historically produced installation fixture with documented provenance, start real runtime, drive actual supported public cap/budget-answer APIs, inspect public nodeRun scopes and later admission. No fabricated SQL invocation/op writer masquerading as E2E.

## Source seam conclusion

Repo-wide rg: src shareBudgetScope only definition, tests only original first declaration. All other ledger functions have production callers. It is a valid eventual dead-function removal, but blocked by intentionally retained old proof until historical fixture cutover. Keep schema, inherited records, shared owner check and arithmetic unchanged. No broad refactor in this campaign.

No independent execution claim made in this review. Root owns exact-limit candidate, deliberate controls and byte-restored final candidate verification, followed by partial retirement verification and eventual full campaign gate.
