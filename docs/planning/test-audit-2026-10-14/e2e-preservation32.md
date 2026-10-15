# Historical-file E2E inventory review 32

Read-only follow-up. Difference between `/tmp/graph-e2e-inventory-pending.json` and checked-in graph inventory is exactly two files: console/unlimited (6 declarations), m8/graph-review-criterion (1). No tests executed and no checkout source/test/routing file edited. Candidate JSON includes current SHA256 values; root owns durable ledger path and final routing edit.

## Whole-file candidate

`tests/m8/graph-review-criterion.test.ts`: genuine complete workflow, 1 declaration / 1 case, 60 lines. Creates real Git repository/baseline and runtime, publishes implementer recipe, public project preparation/graph creation, dispatches native Pi file edit, real workspace_commit then submit via actual HTTP vendor fixture. Actual disk record proves changed integration SHA before inspecting public acceptance. Literal hard constraint status and both diagnostic phrases distinguish a valid refusal from unrelated missing evidence. Read-only TaskStore access observes actual owner data; no SQL seeds or fake receipts.

Owner: `src/core/graph-acceptance.ts` fully read, especially changed-integration review requirement at lines 40–46. Public query flows through graph-service.graphInspect, which invokes that owner. `src/core/graph-runtime.ts` patch lines 130–136 rejects changing declared acceptance, supporting reason the graph cannot repair this in-place. Although this test uses managed graph creation, nonempty declared acceptance is immutable for both managed/confirmed graphs. History 5b00f59 explains diagnostic regression; do not claim this test independently proves patch refusal or successful delivery.

Eligible to register after root turns `/tmp` evidence into durable graph ledger and checks unchanged hash. Existing execution evidence is parent baseline/batch authority; this review adds independent boundary classification, no fresh pass claim.

## Unlimited: retain mixed until explicit split

Read complete `tests/console/unlimited.test.ts`, 136 lines, all six declarations. First five qualify as native E2E: public begin/create/send/host.drive exercises actual Pi/HTTP vendor, owner-produced execution/session/token records, real close/reopen restart, public user budget policy and explicit retry/reconciliation. Exact contracts:

1. Omitted startup cap is unlimited and does not stop after legacy 20M; 2 genuine sends/cumulative 40,000,002, final completion and no budget question.
2. Finite cap prevents transport; user policy is idempotent and closes budget question, does not auto-replay; explicit retry sends original retained input exactly once.
3. Real restart preserves identity/session/cumulative usage and pending finite authorization; subsequent execution changes authorized cap without resetting lineage.
4. Missing provider usage is actually estimated only for unlimited instance; positive usageSource/total and completion with no question.
5. Finite missing usage holds reservation across reopen and policy increase; retry alone makes no send, real recorded call remains unknown; explicit reconcile + retry permits next send and exact used100/reserved0.

Sixth declaration only constructs `openTaskRuntime` directly with zero/negative startup cap and checks exceptions. Root explicitly requires a real CLI process for this edge. **Do not route the current six-declaration file whole.** Candidate JSON places it only in deferred, with a five-plus-one cutover plan.

Owners inspected: task-runtime startup validation and user.task.setBudget; node-executor.runOne budget selection/frozen execution/unknown finite hold; kernel-store.authorizedBudget/setAuthorizedBudget/reserve/release/requestBudget; kernel-provider-gate fully read admission/settlement/reconciliation; kernel-graph-lane actual send uses estimateMissing only for frozen unlimited execution; kernel-views reads actual execution budget/provider calls and real session. Real provider fixture defaults authoritative40+10 tokens per request and supplies missing usage only at external HTTP response boundary.

### Concrete split after freeze

Keep first five native declarations at original path unchanged. Add one actual startup CLI scenario, preferably alongside the config boundary suite or a separate e2e/config-startup case. Spawn project runtime Node on absolute `src/server/cli.ts` with isolated HOME/state/graph-home/config/web-dir, explicit `--port 0 --view-only`. Real temporary index.html prevents unrelated missing-web failure.

Run one positive valid config first (limits.defaultBudgetTokens:null, version1, projects/models/credentials valid/minimal) and fetch actual bound HTTP readiness, then SIGTERM and await exit0. For each zero/negative candidate, write otherwise identical config, run same CLI, assert exit1, stderr contains `limits.defaultBudgetTokens` and the positive-integer diagnostic, no ready banner. Bound process timeout and clean descendants/temp state. Config loader rejects these values before runtime guard; this proves the same public startup contract, not that the constructor's defensive branch ran. CLI main catches startup failure and exits1 (cli.ts 121–127), config positiveInt enforces intended values (config.ts 276–277). Do not invoke imported parseArgs/readGraphConfig directly or fabricate JSON responses.

After keeper pass + intended negative controls, remove original sixth declaration, update inventory declarationCount5 and original names/hashes, then route that original file; no need to rename native tests. As root requested, no edits implemented in this review.

## Applied unlimited cutover and routing

真实CLI已新增tests/e2e/config-contracts第二流程：先相同配置null正常ready且HTTP返回null，再0/-1分别exit1+具体limits.defaultBudgetTokens positive-integer诊断。同harness临时静默猜null导致错误正常启动，被positive rejection guard捕获；恢复config SHA811a0c63ea87b4e61a55b2cbce831676c99e6302a67cefedca9533f437756332后两流程全通过4.24秒。旧constructor声明退休；原unlimited前五native完整保留，并在33批全部通过，才将五声明历史整文件纳e2e route。graph-review-criterion也在cutover32完整通过后登记。
