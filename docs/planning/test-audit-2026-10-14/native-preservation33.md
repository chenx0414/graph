# Native graph whole-file audit 33

Read-only independent lane review, 2026-10-15. All ten requested files read completely, including parameter rows: 1450 test lines, 23 declarations / 27 cases. Full real provider fixture and full hb338 child fixture inspected. No Vitest invocation and no checkout edits. SHA256 of every complete file and all declaration names are in accompanying JSON. Only two complete files are candidates: 4 declarations / 5 cases. Eight mixed files remain lower-level until exact gaps below are handled.

## Reviewed production ownership

Previously read CODING_STANDARDS/CONTEXT, ADR0025/0030, full artifact workspace, public runtime facade and native agent tool handlers. This pass read full GraphLane and kernel-node-host; kernelGraphLane frozen recipe/workspace/access/session rebinding, actual provider IPC/HTTP and commit/integration/finalize/operation callbacks; public task-runtime wiring to kernelGraphLane/hostSubmitCall; GitIntegration workspace/commitWorkspace/integrate/tryDeliver; full kernel-operation-broker causal integration admission, durable settlement and replay; graph acceptance and immutable-declared-acceptance patch guard; Execution.drive macrotask yield and graph failure owner; kernel views and node-executor/driver revision/continuation/settlement entrypoints. Production receipts come from those owners in candidates, never the test fixture.

External vendor replies provide decisions, not owner settlements. Direct Git/file edits in disposable fixture represent real external editor/conflicting change; they are allowed and distinguished from SQL-fabricated operation/call/usage records.

## Whole genuine E2E candidates

### tests/m8/kernel-git-integration.test.ts

Fully read all 206 lines, three declarations/four executed rows including explicit commit and auto-settlement. Public runtime user begin/project prepare/managed graph create/send/host.drive, actual Pi worker writes/commits/publishes/submits over real TCP provider; real Git worktrees/integration, exact persistent code bytes, original target left untouched, original committed artifact remains readable. Real downstream sandboxed command reads merged code; actual competing integration commit produces merge conflict and named blocked check, retaining causal delivery. SQLite/KernelStore only observe owner-produced records, no SQL mutation/receipt seed; real Git fixture changes model external concurrent editor. Production kernelGraphLane session/commit/settleWorkspace/operation wiring, GitIntegration.workspace/commitWorkspace/integrate and full kernel-operation-broker admission/settlement inspected.

- R: `native worker output is integrated from its own worktree and leaves the target branch pending delivery`
- R: `HB-331: a check connected to a submission waits for the real merge (%s)`
- R: `HB-331: a delivery whose source never reached the integration branch blocks the check by name`

### tests/m8/native-repair-freeze.test.ts

Fully read all 129 lines and sole declaration. Public runtime begin/create/send/drive/patch, actual native Pi read/submit over real HTTP vendor; patch while actual response awaits freezes old recipe/task/instructions/workspace/access for repair, next genuine execution adopts new binding while retaining actual instance/history/usage. Model sees exact real file bytes, real outside read refusal then authorized access, real symlink escape/missing directory/worktree prerequisite/host-access negatives cause intended named blocks before any vendor call and retain input/reservation. No SQL writes or injected runner. kernelGraphLane frozen nodeDefinition/nodeLocation/nodeAccess/sessionFor and native session assembly, node-executor frozen execution + repair continuation and public view readers inspected.

- R: `a native Pi node freezes its task and recipe across resubmission, then adopts the next revision`

## Mixed retained: precise migration blockers

### tests/m8/graph-artifact-owner.test.ts

Native main/worker ownership workflow is strong, but lines88-100 instantiate ArtifactWorkspace directly for forged producer node/instance and actorless/forged retire assertions. These are writes/rejections at internal storage boundary, not read-only observation. Keep mixed. Only cutover gap is migrating or separately adjudicating these defensive identity predicates; normal native tools cannot supply producer identity (host derives it). Preserve existing genuine native foreign-owner/other-node/refusal, actual source versions, main retirement replay and graph-only listing; do not claim passing native flow already replaces the direct corrupt-identity guard.

- R/C pending cutover: `main revises %s graph artifacts without transferring authorship or reaching another owner`

### tests/m8/graph-auto-run-e2e.test.ts

First declaration injects actions.master.prepare returning completed/usage without native master. Replace only injected master with genuine local model response and real master definition, keep public conversation proposal/confirm and real native graph unchanged. Second declaration is public empty-runtime bootstrap/host tick with read-only kernel inspection, but it creates no task despite its title; describe as empty-runtime no-spurious-graph. No new fake path is needed.

- R/C pending cutover: `R1/R3: the ordinary host loop drains a confirmed v2 graph through real per-node processes`
- R/C pending cutover: `R2: a task with no v2 graph is untouched by the lane`

### tests/m8/graph-completion-e2e.test.ts

Sole declaration bypasses product runtime by manually creating TaskStore tasks/revision/admission/NodeQueue and ResidentHost GraphLane config. It additionally INSERTs unknown provider call with nonexistent exec-gone, directly mutates numeric authorized_budget and inflight state. Must replace manual assembly with public runtime and actual provider behavior. Missing-usage states should originate real missing-usage or interrupted sends, finite policy through user.setBudget; preserve actual unlimited-unknown and inflight-drain contracts separately, not merely rename. Malformed submit correction should move into existing public native submit keeper and keep one-valid-submit guarantee.

- R/C pending cutover: `a submits, the delivery queues b, b submits by its own real process, and the graph drains`

### tests/m8/graph-final-acceptance.test.ts

Nearly entire sole declaration is real public runtime/Git/native review/user approval/delivery. Only lower boundary is lines78-88 direct executeModuleOperation replay on reopened store with caller-built options. Replace replay proof with actual runtime process stop/reopen between durable command settlement and input acknowledgement, preserving exact large result decode and one command-dispatched record. Existing real dirty-target/dirty-integration/unverified-commit guards are legitimate fixture edits and must stay. Do not drop replay assertion merely to route whole.

- R/C pending cutover: `native final acceptance binds real checks, independent published review and user approval before exact Git delivery`

### tests/m8/kernel-e2e-real-pi.test.ts

Sole declaration does run real Pi but test constructs kernel task/admission/queue and hand-wires ResidentHost.onToolCall submission bridge/driver/executor. This reproduces production assembly, not full product API workflow. Consolidate exact submit delivery bytes/completed execution and actual transport into public graph create/send/native host keeper; per-node-process requirement needs public owner-produced process/session evidence, not test-supplied binding/digests.

- R/C pending cutover: `the node calls submit, the host executes it, and the delivery is on disk`

### tests/m8/execution-drive-liveness.test.ts

Both two-row declarations spawn real child, but full child fixture hb338-drive-liveness.ts inserts projects/tasks/nodes/instances/activations/runtime state and injects GraphLane.operation throwing paused or returning passed plus fake main action. Process boundary alone does not make it E2E. Replace scenario child with complete openTaskRuntime/public graph/main creation, real integration-causal pre-dispatch wait (worker native submit while real HTTP response held) and real waiting main HTTP provider. Keep parent hard-kill supervisor, macrotask heartbeat, resume-vs-stop, no-main-vs-main matrix, exact retained delivery/one operation settlement; synthetic operation callback cannot survive cutover.

- R/C pending cutover: `a graph waiting before dispatch never starves the event loop, and the same delivery continues (%s)`
- R/C pending cutover: `stopping while a graph waits before dispatch exits cleanly and keeps the delivery pending (%s)`

### tests/m8/graph-failure-visible.test.ts

All four declarations inject Execution.graphs callbacks that throw/return success and SQL-create task. No native/public workflow. Intended failure diagnostic/de-dup/global-unattributable diagnostic/healthy absence remain contracts; need genuine runtime failure via real missing credential or externally corrupted disposable storage and public event stream, with intended guard evidence. Global graph-list failure is separate internal diagnostic edge that may require deliberate decision if no public reproduction; no blanket deletion or E2E registration.

- R/C pending cutover: `E1: a graph that throws leaves a task event naming the reason`
- R/C pending cutover: `E2: the same failing graph is reported once, not flooded on every tick`
- R/C pending cutover: `E3: a lane that cannot even list its graphs is reported, not hidden`
- R/C pending cutover: `E4: a healthy graph produces no failure event`

### tests/m8/graph-lane-run.test.ts

All seven declarations use fakeHost with fabricated processId/turn/inspect, hand-create graphs/admit nodes, direct phase/pause/revision SQL. L1 title claims queue emptied but only checks no longer runnable after no-submit failure; not equivalent success. Public native chain keeper absorbs L1/L2/L5 real per-node host identity; L3 no revision is corrupted/internal state, L4 public pause/terminal with retained input, final two async preparation patch and stale completion-after-stop need actual public runtime race flows. Native-repair-freeze catches patch during response, not async host-preparation seam; do not claim exact duplicate until intended race keeper exists.

- R/C pending cutover: `L1: a graph with a queued item is runnable, and draining it empties the queue`
- R/C pending cutover: `L2: a graph with nothing queued is not proposed`
- R/C pending cutover: `L3: a task with no published revision is never proposed`
- R/C pending cutover: `L4: a paused or terminal task is not runnable`
- R/C pending cutover: `L5: the lane resolves the host and config per NODE, not per graph`
- R/C pending cutover: `a patch during asynchronous host preparation takes effect only on the next execution`
- R/C pending cutover: `a runnable completion captured before stop cannot complete the stopped graph`

## Routing and evidence limits

No filenames containing e2e determine classification. Read-only access to actual SQLite rows does not invalidate candidate workflows. Calls which write/reject at internal owner boundaries, fake driver settlement, SQL-created credentials/operations/calls, and manually assembled product transport remain mixed even when placed inside one long native test.

Candidate kernel-git-integration's 2-second controlled vendor response delay creates a real submit-before-settlement window; assertions use final exact causal receipt and integrated bytes, not arbitrary timers. native-repair-freeze synchronizes actual patch via external vendor beforeReply and observes both execution generations and distinct file permissions. Existing passing baseline is parent authority; this independent pass makes no fresh green claim. Root must hash-check and write durable ledger paths before adding eligible entries to executable routing JSON, then run focused candidates/siblings after freeze ends.
