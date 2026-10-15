# Graph definition owner audit — read-only

Pinned baseline supplied by root: 463fa2c, all 271 files / 1852 cases passed. This batch inspected all declarations and parameter rows in interface-spec, v2-definitions, confirm-graph, operation-intent, design-examples and m2/templates, the definition fixture, native-patterns and native-worktree-graph. Production: interface-spec, confirm-graph, graph-service, proposal, task-runtime confirmation, operation-lifecycle event creation and insights event rendering. CODING_STANDARDS, CONTEXT, ADR0030, campaign and audit checklist read. No repository edits or test runs performed.

## Authority and history

ADR0030 requires one v2 delivery runtime; old DAG shapes cannot coexist. GraphManagement.graphCreate validates raw input before inserting task/owner/request rows, then admits instances and modules in a transaction. GraphRuntime.create/patch and KernelStore.insertRevision reuse the parser. Proposal validation runs before conversation confirmation, which materializes inside store.command's transaction. Confirm replay returns existing receipt, rather than exercising materializeGraph's internal duplicate guard. Thus do NOT reinterpret the private guard as a user promise of duplicate rejection: the public promise is idempotent replay and conflicting-request refusal.

History inspected: cc66f6c explicit edge enablement; e046c79 mixed native/legacy drafts; 6dc73a2 v2 replacement; e6b922f draft changes; 463fa2c full node instructions; 34b6206 original operation.intent duplicate-spec regression; 0b4bdb9 original phase-1b fixture-shape tests. protocolReferenced has zero production callers (rg src returns declaration only), and it tests declared protocol existence rather than actual references. It is eligible for deletion with its tests after checking all repository callers.

## Per-declaration ledger

C means retain observable contract at named real public-runtime keeper before retiring direct test. F means repair evidence in that migration. R means preserve existing real runtime E2E. D means no independent behavior beyond fixture inventory.

### tests/m8/interface-spec.test.ts

| Line | Mark | Declaration / observable contract / keeper |
|---|---|---|
|68|C/D|Well-formed pipeline accepted: C into public graphCreate then real Pi input→submission→results→completion; D protocolReferenced true/false and Object.keys fixture inventory (no production caller). Existing m2/templates proves running native pipelines.|
|77|C|All 3 command-on-node rows rejected: graphCreate raw definition rejection table, assert invalid_definition and operation-module message, unchanged owner graph listing. No parseGraphDefinition before call.|
|85|C|Unknown graph input and 7 workspace/access malformed rows: same creation-rejection table with exact intended error fragment and state unchanged; valid neighboring creation and execution control. Security/path contracts cannot be deleted.|
|101|C|7 non-boolean edge rows and undeclared endpoint: graphCreate refusal table; preserve both explicit false and true as actual delivery/routing scenarios, not parsed flags.|
|120|C|Endpoint version mismatch: raw graphCreate rejection, error identifies differing protocol/version. Valid equal-version graph runs as control.|
|137|F|Name claims case-distinct nodes but only exercises blank edge ID: rename to blank-edge refusal; create blank ID with otherwise valid enabled edge so rejection reaches blank-key guard. Do not invent case-distinct evidence.|
|145|C|Rework loop acceptance: absorbed by m2/templates optimize real Pi review loop, which actually reexecutes worker and publishes version 2. Fixture inventory assertions unnecessary.|
|186|C|Two edges to same input: must retain a public graphSend workflow proving two distinct accepted queue entries/executions. m2/templates fanout joins distinct inputs and does NOT prove this.|
|208|C|Unsupported version: raw graphCreate refusal table.|
|211|C|Undeclared output protocol: raw graphCreate refusal table, precise unknown-protocol message.|
|217|C|Undeclared required output: raw graphCreate refusal table.|
|226|F/C|Enum, additionalProperties, nonempty array, positive nested integer: use actual graphSend input protocol refusal table; each refusal leaves queue and provider request count unchanged; valid value then real Pi output appears unchanged. Current test does NOT assert immutability despite name; no invented preservation assertion. Invalid schema declaration belongs creation refusal table.|
|239|C|10 model/retry/instructions rows: raw graphCreate refusal table, preserve exact intended model/retry/instructions guard.|
|245|C|7 graph-default rows: raw graphCreate refusal table with defaults fragment and unchanged persisted graphs.|
|253|C|7 final acceptance rows: raw graphCreate refusal table; invalid checklist, duplicate IDs, missing descriptions/kind, missing check/review endpoint, unauthorized passed field remain independent acceptance/security contracts.|

### tests/m8/v2-definitions.test.ts

| Line | Mark | Evidence |
|---|---|---|
|17|D/C|D fixture node/schema/submission inventory; C automatic output-triggered completion cannot disappear: existing m2/templates explicitly completes graphs and does NOT prove completion.on. Add real Pi fixture pipeline output causing automatic completion at public runtime before deleting completion assertions.|
|25|D|Edge/rule-count inventory duplicates executable optimize rework and documented branch routing keepers; m2/templates and design-examples retain actual routing.|
|33|D|Node-count/requiredInputs/edge inventory duplicates real Pi fanout/join in m2/templates plus once/reopen public workflow design-examples.|
|42|D|JSON source inventory of absent legacy words: no independent execution behavior; public legacy proposal refusal keeper protects actual boundary, parser rejects unsupported node fields.|

### tests/m8/confirm-graph.test.ts

| Line | Mark | Migration |
|---|---|---|
|63 W1|C|Revision 1 and admitted nodes/modules: use public conversation confirmation keeper, graphInspect revision/module/queue plus eventual real node execution. Existing W5 already asserts same admitted node/module SQL rows.|
|75 W2|C|Instance identities and initially empty queues: same confirmation workflow, await idle then valid input with real Pi, runtime.nodeRun identity/public views. W5 SQL truthiness alone not proof runnable; graph-auto-run-e2e real two-node flow proves execution.|
|86 W3|C|Private duplicate materialization: public confirm replay must create one task and no second supervisor wake. Preserve W5 existing replay assertion; public graphCreate requestId same-content replay and changed-content refusal are separate graph-service contracts. Do not keep direct materialize invocation.|
|97 W4|C|Whole-or-nothing invalid definition: raw public graphCreate/propose refusal table, owner task/graph list unchanged before valid control. Private empty kernel row checks redundant once actual creation surface proves no task/ownership created.|
|113 W5|F/C|Full drafted/confirmed graph geometry, no queued inputs, main graph_ready wake, replay dedupe and v2-only storage: current mocked ActionAdapter supplies master behavior. Replace scripted master with real openaiServer + native production Pi; bind/propose/confirm via public runtime, exercise graph input to completion, retain HTTP projection assertions if transport independent. Existing graph-auto-run-e2e does not cover all geometry/wake/replay checks.|
|195 W6|F/C|Legacy refusal: replace scripted master with same real-Pi confirmation fixture; propose legacy draft fails invalid_proposal, confirm stale_proposal, feature list stays empty. Input must remain raw legacy shape (no native prevalidation). Preserve mixed native+legacy row from actual proposal validator if adding to consolidated table.|
|231 each|C|Chain/disconnected/cycle all start idle; invalid protocol input queues nothing; valid input starts only target. Consolidate public graphCreate real Pi table; pause untouched b if needed, graphInspect queues and executions. Must preserve all topology rows; current direct materialize/GraphRuntime is integration.|

### tests/m1/operation-intent.test.ts

This is a runtime/event owner, not definition parsing. Its original bug HB-43(b), 34b6206, is real storage amplification, not disposable static proof.

| Line | Mark | Migration |
|---|---|---|
|15|C|Real conversation native master request with large input, actual runtime.events operation.intent payload <600 bytes, no input/dependencies/context, specRef and operation identity correspond to actual persisted operations.spec (read-only DB evidence acceptable). Large operation spec must truly be on disk; do not construct asserted event with operationIntentEvent helper. Move runtime keeper; cannot delete before absorbed.|
|33|C|UI timeline operation identity/tone: render actual operation.intent in browser insights from real runtime events, assert visible actual operation ID and active status. Mere buildTimeline(actualEvents) remains integration and does not satisfy user full E2E request. Distinct UI transport/projection risk, so keep independently at browser boundary.|

### Existing keeper declarations

R design-examples:15 creation of documented definitions through public runtime; R :32 documented router/join/send/reopen complete public module flow. R m2/templates:14 pipeline/fanout/router/supervisor-worker real Pi + native command outputs + completion; R :122 optimize/adversarial/multiview/jury immutable artifact/version/exact-review joins. Preserve all; none calls private kernel writes. Existing graph-auto-run-e2e and native-repair-freeze strong execution keepers identified in prior reading, but not fully audited in this bounded batch.

## Concrete migration sequence

1. Add a single native definition E2E fixture using real openaiServer, openTaskRuntime, real temp SQLite/project, real Pi recipe. public user.begin and supervisor graphCreate/Send/Inspect/Control; no injected ActionAdapter, manual node admission, private-state inserts, or helper-only assertions. Model submits independently scripted literal expected result. Temp project Git can be prepared normally through runtime.projects.prepare.
2. Copy every invalid-input row above into one shared creation-refusal table declaration. New keeper has no parseGraphDefinition call: raw bad definitions must reach real service parser. Assert exact code/message and unchanged public owner graph collection (or read-only persisted rows if public API lacks listing); each table mutation must fail at intended guard. Follow all rejections with valid creation plus real native execution/result control. This full flow makes rejection scenario E2E rather than parser tests in a new filename.
3. One protocol-delivery rejection table within valid created graph: bad input leaves queue/provider count unchanged; valid nested input traverses real Pi → required submission → result unchanged; actual postcondition necessary.
4. One topology/initial-idle + fan-in/delivery scenario table; public real execution for accepted input. Extend native template keeper for the uncovered completion.on auto-completion behavior, rather than claiming manual complete proves it.
5. Replace confirm-graph mocked master with actual native Pi plans. Retain W5 geometry/wake/replay and W6 legacy refusal. Remove 4 private materialization declarations and 3 direct topology parameter rows only after public replacements pass.
6. Delete fixture inventory suite; remove protocolReferenced only after repository-wide caller check. Do NOT delete materializeGraph or operationIntentEvent: both have real production callers.
7. Runtime/browser owners absorb operation-intent storage and timeline assertions before original file deletion. This batch cannot independently retire operation-intent yet.

Retire candidates: interface-spec direct suite after tables absorbed; v2-definitions after completion.on gap closed; confirm-graph direct/private declarations after public native keeper; operation-intent after runtime/browser keeper. Focused validation: keeper files + design-examples + templates + graph-auto-run-e2e; full root check and preservation autoreview later. No test deletion justified merely by count. Inventory-only deletions are high confidence; retained protocol/default/security/acceptance bytes are essential contracts.

## Implementation staging (keepers not yet run)

Created tests/e2e/graph-definitions.test.ts: 4 workflow declarations absorb creation refusal rows, protocol delivery guards, explicit true/false routing and same-input multiple delivery, all 3 initial topology rows, and automatic completion.on (real Pi process + runtime + SQLite + prepared Git). Created tests/e2e/graph-confirmation.test.ts: 2 workflows replacing injected master with native Pi while preserving draft/confirmed HTTP projection, graph_ready prompt, replay no extra model turn, persisted v2-only rows, and actual a→b submit/delivery execution. This is 6 declarations versus original 26 across three suites, with existing templates/design examples unchanged. Original suites and protocolReferenced temporarily remain until root provides stable validation window and new keepers pass. No Vitest or check launched during edits. Operation-intent excluded from implementation ownership.
