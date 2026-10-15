# Native historical E2E audit lane 38

Read-only audit: repository unchanged; no tests executed. Root full run window is authoritative. 10 files / 49 declarations; parameterized declarations retained as one ledger item (node-executor expands 13 declarations to 24 cases). Only two NEW wholefile routing candidates (4 cases). tool-failure-record is already registered and must not be appended twice.

## Production/fixture evidence

- Read CONTEXT, CODING_STANDARDS, tests/AGENTS, test-audit SKILL/CAMPAIGN, ADR0030. The referenced docs/help/testing/writing-tests.md does not exist at this checkout.
- Fully read all 10 assigned files, openai-server.ts, resident-host.ts and resident-worker-entry.ts. Source owners traced through openTaskRuntime public begin/propose/accept/controlGraph/nodeRun, supervisor graphManagement create/send/inspect, real execution graphs kernelGraphLane -> ResidentHost/residentLauncher -> actual model HTTP and native tool handlers. Relevant owner implementations read around construction/materialization/lane configuration, workspace/tool bindings and real model dispatch. This is not a claim that every line of the 2,500-line task-runtime file was read.
- openGraphServer actually calls app.listen, creates real runtime and exposes browser/SSE owner state. Rework-ui uses actual Vite build + Chromium without route interception, public native graph create/send, and operation workspace.command invokes Node subprocess. Usage UI explicitly replaces OWN UsageService, so same real server/browser does not qualify it.
- Existing default Vitest includes tests/**/*.test.ts. tests/e2e-routing.ts manifest excludes fully audited wholefiles from unit config; filenames alone confer no exclusion. Read current graph manifest tool-failure-record entry (already registered runtime-preservation34). Read path history for completion/rework-ui: 6dc73a2 native replacement and e6b922f draft lifecycle changes; no code edit made.

## Wholefile candidates

### tests/m8/rework.test.ts

SHA256 `3b96a98711f5ac68b0ddc0cef6d9f34766d49ca70c48150054dc698fabdc422d`; fully read 566 lines / 13 declarations; mixed_or_lower_level.

1. **R** `credential aliases resolving to the same actual key share one limit` — Two alias rows use actual daemon configuration/env resolution; real workers/models send to tracking HTTP vendor; host persisted 12-token usage and startup sanitization/alias DTO. True existing E2E.
2. **R** `ten waiters on key A do not block an independent key B` — Public runtime creates 11 native workers; real scheduler acquire holds key A while actual worker B completes at real vendor. Concrete production scheduler, not mock. Caveat: hold injected at scheduler API, not produced by an actual competing user request.
3. **R** `tasks record the effective revision immediately after a hot apply` — Real daemon POST /api/config, POST /api/tasks, event history, close/restart; next task retains effective revision across restart. Complete HTTP config lifecycle.
4. **R** `a project removed from the config keeps its history but cannot receive new tasks` — Actual persisted task is created via HTTP before config drops project; restart settings omit project, task history remains, new HTTP task rejected. Complete historical lifecycle.
5. **C** `a retry re-acquires the slot only after releasing it for the backoff` — LOWER: controlledOpenAIStream receives hand-written broker whose dispatch merely calls send and settle is no-op; no business runtime, no real billing owner. Preserve backoff slot release contract by extending real credential-queue/native runtime keeper, not route as E2E.
6. **R** `resumed waiters re-acquire the global Agent execution slot` — Actual 20-worker runtime queue, real scheduler holds release, native sends enforce global max 10. Existing E2E with concrete scheduler congestion injection; no synthetic receipt.
7. **R** `conflicting alias groups are refused at save time and a hand-edited conflict still starts view-only` — Real daemon config POST rejects same-ref/same-value conflicting alias groups without file mutation/revision bump; fixed save then hand-edit/restart view-only startup and execute-mode rejection. True config HTTP/file/restart lifecycle.
8. **R** `a paused pre-send refusal is not a success and the nodes run after resume` — Actual 20 native nodes queued behind real scheduler holds, public task.pause prevents all vendor sends/charges, then public resume dispatches. Native owner writes blocked operations. Concrete hold API injection caveat as above.
9. **R** `a pause after partial work preserves the real file and continues the same execution and session` — Real worker write_file creates actual file; wrapper around real scheduler acquire invokes public task.pause at second send, then public resume continues same execution/session. No fabricated host result. Timing stimulus attached to real scheduler, not natural UI pause producer.
10. **R** `unknown usage after a partial write keeps its hold through resume until main records the exact call usage` — Actual file write plus actual external SSE usage:null produces native unknown hold; resume cannot send; public main reconciliation requires exact usage and is idempotent; actual worker continues same operation/session. True E2E.
11. **R** `mixed known and unknown usage preserves both real writes and counts each provider call once on continuation` — Actual two file writes plus usage:null response, native ledger charges known/unknown calls once, public reconciliation/resume retains session/operation and files. True E2E.
12. **R** `the second round of explicit rework reads the failure delta and preserves its actual original conversation` — Real two-model worker/reviewer graph submits -> router rework -> actual worker second execution; true wire delta preserves worker private conversation but excludes reviewer private text; real deliveries/results. True E2E.
13. **R** `unknown usage in a rework round cannot reuse the first submission and resumes the same pending execution after reconciliation` — Real rework second execution writes actual fix.txt then unknown usage parks; no premature second result; explicit public reconciliation resumes same session/execution and produces second real submit/review. True E2E.

### tests/m8/rework-ui.test.ts

SHA256 `c4d9a77ffa34e600310153e0260fdc454637d574a1d3c4a137e00036396970d2`; fully read 66 lines / 1 declarations; genuine_e2e.

1. **R** `the graph refreshes native Agent and module state from task events without navigation` — Real native Agent submit -> real operation module subprocess -> real task events/SSE state update in actual built Chromium UI, URL unchanged. Also exact edge emitted value and actual module code0/passed result. Scope excludes UI graph authoring and arbitrary event byte preservation.

### tests/m8/usage.test.ts

SHA256 `648bef9338187f26eabc14c7f9cc4207ebf6620ab7a6b5e6cdd6c6c1e79f80a3`; fully read 329 lines / 4 declarations; mixed_or_lower_level.

1. **C** `an account whose key cannot be resolved stays visible as unconfigured` — Direct createUsageService with fabricated parsed GraphConfig/loadConfig and fake fetch function; tests missing-key account visibility/no outbound call. Migrate into real daemon config + actual HTTP vendor + usage page/API.
2. **C** `a platform with several accounts reports every account with its own quota` — Direct usage service with fake fetch distinguishing Authorization and fabricated config. Independent account quota identity contract, preserve via real configured daemon + external HTTP fixture, not eligible wholefile.
3. **C** `usage service normalizes the five supported subscription sources` — Direct usage service normalizer table uses real disk pricing/OpenCode config but fake fetch callback returns five supplier schemas; independent protocol contract retained. Use real network transport adapters/HTTP fixture at public daemon boundary before retirement.
4. **C** `the usage page shows subscription cards and refreshes without model pricing` — Real Chromium/browser/server but OWN UsageService fake returns entirely fabricated cards/quotas and forced flag. UI shell is real, business subscription owner replaced. Carry card balances/unconfigured/refresh/no-pricing assertions into actual usage service keeper.

### tests/m8/v2-pause.test.ts

SHA256 `d0388b758828b39beece44c793a2db79f70e82470737caeafc57dc4d502acf6c`; fully read 157 lines / 5 declarations; mixed_or_lower_level.

1. **C** `P1: a paused node is never turned, and its work stays queued` — SQL projects/tasks + KernelStore enqueue + fabricated host + supplied runner. Preserve paused no-send/queue-retained through public runtime real vendor.
2. **C** `P2: resuming the node lets the turn happen` — Same seeded kernel/fake host; runner directly calls kernel.submit. Preserve resume dispatch via real worker; not real submit producer.
3. **C** `U1/U4: a turn that reports nothing holds its reservation; one that reports settles` — Seeded kernel/fake runner returns missing without usage. Despite U1/U4 title only unknown hold/blocked branch asserted; no reported-success comparison. Keep independent unknown accounting in real native keeper.
4. **C** `U2: recording the unknown usage charges the hold and frees the node` — Direct reserveNodeTokens/blockNode/reconcileNodeUsage(record), no actual call incurred. Preserve exact recording contract at public reconciliation/native vendor.
5. **C** `U3: releasing the unknown hold returns it and frees the node` — Direct reserveNodeTokens/blockNode/reconcileNodeUsage(release). Need classify current supported release contract with production public API before migration; do not drop solely because new explicit-usage API differs.

### tests/m8/v2-budget-blocking.test.ts

SHA256 `83191b22719f4f12eb6443fdee384b34df52186be00264decbcc962e151f7e6d`; fully read 143 lines / 4 declarations; mixed_or_lower_level.

1. **C** `M1/M3/M4: a node that cannot afford its turn is blocked, keeps its state, and reserves nothing` — SQL kernel/fake host and no-op runner test refusal/visible block/no reservation; preserve through real public runtime budget config and absent vendor request after positive path.
2. **C** `U1: a turn that reports usage is charged, so the budget shrinks by what it cost` — Fake runner supplies usage total250 on each missing-required attempt; preserve counted failed attempts from real SSE usage.
3. **C** `U2: a turn that reports nothing is not charged as zero-known; usage stays unknown` — Fake runner supplies missing, no usage; assertion only used==0, no positive unknown hold guard. Repair lower assertion during native carry; real unknown evidence must retain reservation.
4. **C** `M1: a node within budget runs, and its reservation is settled afterwards` — Runner directly kernel.submit plus supplied usage100. Need actual model submit and actual measured usage settlement.

### tests/m8/v2-completion.test.ts

SHA256 `ed958ccaa08804cb4b55b0dde650cba3dd0fd52f0ae95844271eaa5913521422`; fully read 80 lines / 3 declarations; genuine_e2e.

1. **R** `C1: a v2 node that submits reads succeeded` — C1 actual native model submits required output, public node status succeeded. Non-Git scope deliberate; no merge delivery proof.
2. **R** `C2: successful node status cannot replace confirmed human acceptance` — C2 explicit completion cannot substitute successful node status for unconfirmed human acceptance: public task blocked + acceptance missing. No human-confirmation success claim.
3. **R** `C3: a node that cannot supply its required output stays visible as failed` — C3 actual second model worker repeatedly omits required output and public status fails; first actual submitted worker proves success contrast.

### tests/m8/v2-failure-visible.test.ts

SHA256 `79127c8e5d47bfbc594f2e637d697a1a725cf5df921cf1431d2899e3d4880388`; fully read 80 lines / 2 declarations; mixed_or_lower_level.

1. **C** `F1/F2/F3: a failed node is marked failed, records the reason, and emits an event` — SQL kernel/fake host supplied missing output/usage; SELECT checks native failure reason/event. Migrate real required-output failure, preserve both persistent queue reason and graph.node.failed payload.
2. **C** `F4: a blocked node is reported as blocked, which is a different fact` — Same fake executor budget gate; asserts blocked vs failed events. Preserve event distinction through actual budget refusal public lifecycle.

### tests/m8/node-executor.test.ts

SHA256 `8f4bdab57b4993008937315e40bad8534677be3bc2bf6b86163933627588336c`; fully read 447 lines / 13 declarations; mixed_or_lower_level.

1. **C** `X1: a valid submit settles the item and completes the execution` — X1 uses SQL-created task and fakeHost; supplied runner calls kernel.submit directly. True worker submission must absorb outcome, exec-id, pause and drained queue assertions.
2. **C** `X2/X3: retries re-turn the same execution, then the node fails and pauses` — X2/X3 same seeded/fake host, runner returns nothing; exact 3 attempts/same execution/paused failure are independent retry contract.
3. **C** `X4/X5: a missing-required submit injects the gap into the same execution` — X4/X5 supplied runner returns missing array; direct resubmit injection callback assertions. Carry actual model follow-up prompt and exhausted failed status.
4. **C** `restart preserves the automatic retry allowance with budget snapshot %s` — Two restart rows seed formal execution/attempt/retry/budget state through kernel, close/reopen disk; fake host/runner resume. Genuine persistence but not complete native business. Preserve frozen revision/budget/retry allowance and legacy missing budget blocking via real owner historical write or clearly scoped compatibility fixture.
5. **C** `X6: runNode drains the node queue one execution at a time` — X6 fake runner instantaneous increments/decrements and direct submit; maxRunning==1 is partly supplied by synchronous callback. Real queued two worker turns plus held vendor can prove serial ordering/non-overlap.
6. **C** `X7: a dead process is rebuilt and the same execution resumes` — X7 fakeHost(false) restarts flag, runner scripts crash/no-submit then direct submit; no actual OS crash. Real process kill/recovery keeper required.
7. **C** `provider gate charges each send before a follow-up, refuses exhausted budget and retains unknown usage` — Direct kernelProviderGate with fake send counters, seeded execution and manual settlement; preserve pre-send budget gate/unknown stop through real HTTP model and real owner billing.
8. **C** `runtime recovery retains input, attempt counters and unknown provider holds; reconciliation is explicit and idempotent` — Manually claims input/starts execution/notes retries/reserves/dispatches then recovery function twice; seeded formal history, not runtime producer. Need real interrupted request + reopened runtime and explicit idempotent reconciliation.
9. **C** `a missing review model parks the input without consuming automatic retries or token holds` — host factory throws RuntimeError(model_selection); no real directory/model selection. Preserve unavailable independent review model with actual model registry/runtime admission.
10. **C** `a submitted execution with %s and unknown usage cannot replay its original input` — Two rows fakeHost + direct submit + synthetic unknown gate, then supplied throw/unknown result; includes public graphManagement only AFTER false business setup. Preserve post-submit no replay, frozen budget, unknown holds, persisted history and cursor rejection in true public keeper.
11. **C** `declared $scope $mode retry limits stay frozen for current work and change on the next execution` — Four rows fakeHost and supplied fail runner mutate revision midexecution. Preserve node/graph retry defaults frozen for current execution, next revision applies next work via real blocked/held vendor.
12. **C** `declarative budget admission: $name` — Seven declarative quota rows fakeHost and supplied usage; preserve graph default/node override/zero/refused increase/refused unlimited/authorized unlimited/authorized finite through real public runtime model sends.
13. **C** `live user default budgets are read for new work without changing the active execution` — Live budget function changed from supplied runner; retains active execution snapshot vs next execution using real mutable owner configuration and held actual worker send.

### tests/m8/tool-channel.test.ts

SHA256 `b4f5aea3de4def30d61d2e7d095c597f040ac29988fa8fa2afa4e983966f1084`; fully read 153 lines / 3 declarations; mixed_or_lower_level.

1. **C** `T1/T5: a node tool call reaches the host, and the host answer returns to the model` — Real child resident worker and vendor transport, but onToolCall fabricates accepted/submissionId receipt with no real kernel. Existing IPC spike, not full business E2E. Also T5 title overclaims: asserts calls and request count, not actual receipt in subsequent wire context.
2. **C** `T2: a refusal returns to the model as a correctable error, not a crash` — Real child process but onToolCall returns scripted refusal then accepted, no kernel validates disabled output. Preserve correctable refusal through actual host submit handler + corrected real submit.
3. **C** `T3: a call to a tool the host does not offer is refused, not silently ignored` — Real child process routes unknown tool internally, test fake host handler has seen list. Distinct worker tool-denial contract, but not full runtime. Carry unknown tool refusal and next-turn continuation into real daemon/native worker.

### tests/m8/tool-failure-record.test.ts

SHA256 `79b8799ce6ee0e1b98150cd7d36769b6145d8cb28d637032a9579ddb786e8936`; fully read 103 lines / 1 declarations; already_registered.

1. **R** `a failed tool call leaves its reason in the node record, readable afterwards` — ALREADY REGISTERED. Actual daemon/public proposal/accept/send, native read tool nonexistent file error written by real host; nodeRun result reason machine-readable/display-text. Positive failed row exists before negatives. Last loop excludes text containing 失败 and therefore is weak success control, not proof of actual successful tool call. Preserve suite; no duplicate candidate.

## Rework exact split candidate (conservative public-stimulus revision)

- `/tmp/graph-rework-e2e38.test.ts`: 8 original declaration bodies unchanged: credential alias same actual key; hot effective revision; removed project historical tasks; conflicting alias groups save/restart; unknown partial write reconciliation; mixed known/unknown write continuation; actual second-round rework conversation; unknown rework round reconciliation. Expected executed cases: 8 (alias has internal two-fixture loop, not test.each).
- `/tmp/graph-rework-lower38.test.ts`: 5 original declaration bodies unchanged: ten waiters key A vs B; standalone retry backoff; resumed waiters global limit; paused pre-send refusal; pause after partial work.
- E2E support `partialWork` has two callers, both original default `pauseAfterWrite=false`: unknown partial write and mixed known/unknown. Its inert internal acquire wrapper is removed in candidate in favor of concrete `createModelScheduler()` (same actual scheduler as old delegated calls); optional pause parameter removed. No asserted behavior is supplied by own collaborator. Lower support retains its wrapper, and its sole remaining call passes `true`, so second-acquire public pause timing remains lower until real vendor-held stimulus migration.
- Native split drops unused createNetServer/normalizeContext/controlledOpenAIStream/InMemoryCredentialStore/ModelRuntime/openGraphServer imports; keeps actual startGraphDaemon, trackingProvider, Git alias fixture, native startWorkers, default concrete scheduler for unknown usage, real partial-work/rework fixtures. Import relative depths already fit tests/e2e/rework-runtime.test.ts.
- Lower keeps real scheduler/model/server fixtures because three waiters cases exercise concrete native owners, but manual internal scheduler acquire is intentionally not enough for requested E2E classification. Lower drops unused daemon import, git helper/import, and unrelated reworkGraph/result/lastUser support. Test bodies unchanged.
- Future true keepers: make real public worker or conversation requests occupy same-key/vendor slots with held external HTTP replies; create 10 real running workers to occupy global execution slots. Pause actual graph via public user action after vendor observes true write/second-send barrier, not wrapper counting internal acquire. Backoff keeper needs actual native runtime/vendor refusal and competing public worker response during backoff; no fabricated broker.
- No repository source/tests/routing edits or test execution. Root must hash-check original, persist reviewed ledger, apply outside checkout freeze and run keepers/sibling evidence. These tmp candidates do not themselves authorize routing whole original rework file.
