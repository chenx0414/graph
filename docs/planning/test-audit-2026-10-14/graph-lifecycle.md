# Graph lifecycle layer cutover

Full lower owner tests/m8/graph-runtime.test.ts 488 lines / 22 declarations including all parameter rows read, full production GraphRuntime367 / graphManagement189 read. Old tests create fabricated graph/task/admission/execution/settlement directly. Actual product creation is graphManagement's public admission transaction; GraphRuntime.create/deliver have no production callers but other fixture consumers still use them, so their removal awaits whole-layer migration.

Root batch27: initial tests/e2e/graph-lifecycle.test.ts two full public workflows green and typecheck green. First creates real public graphs, pauses and accepts queued work, requests completion, requires blocked/closed input until withdrawal, stops while paused and checks real cancellation, then real once module fires and completes; every execution control on stopped/completed rejects, settled queue generation and once latch remain unchanged. Second holds actual vendor response before native submit, disables the connection so actual submit cannot send, enables future output and accepts it into paused recipient, removes edge but recipient still receives literal seven after resume, atomic/stale patches preserve revision and retiring after execution preserves real transcript.

## Exact retired declarations after batch27

| Old declaration | Keeper |
| --- | --- |
| blocked completion intent closed/withdrawable | First public lifecycle blocked request/refused delivery and chat/withdraw |
| connection disabled during execution changes later submit | Second actual held native submit before public disable, edge delivery empty |
| acceptance cannot weaken | Existing real public m2/revision declared acceptance freeze |
| G1 stale base says current revision, zero changes | Second public stale base3/current4 with exact diagnostic and original revision |
| G2 accepted input survives later connection change | Second actual queued native recipient processes previously accepted seven after edge removal |
| G3/G6 complete refuses input then withdrawal opens | First public queued lifecycle and withdrawal followed by actual gate/new control |
| G4b no pending failure completes | First actual once module result then explicit completion; existing native m2/graphs successful flows |
| G5 stop while paused cancels queue and closes dispatch | First public pause/stop/unpaused host cancellation and exact queue reason |
| pending node retirement refused | Second actual paused accepted recipient refuses retire pending_work, same instance retained |
| terminal completed/stopped cannot reopen via any controls | First table actually completes/stops graphs, all8 controls and patch/withdraw refuse, once latch unchanged, idempotent stop/complete |

Ten declarations (eleven expanded cases) retired. Remaining twelve declarations retain unique or not-yet-exactly-absorbed contracts; no blanket delete. In particular original aggregate local patch guard still includes active settled-queue control and unknown retired target tests; new second scenario does not yet claim them all.

## Staged continuation

Two further genuine flows appended, pending root owner proof: (1) four literal node IDs plain/bracket/star/question fail once, retry actual generation1, native valid output then missing promised file fails, attempted replay refuses intended Submitted work and skip permits blocked completion to drain; no fabricated executions, usage or receipts. (2) actual Git branch missing preparation fails after public creation, create that branch in real fixture, repeat same request returns same graph ready and idempotent third request, conflicting content refuses without revision mutation. Initial prompt proof in second flow strengthened to actual absence before send, active timing, and byte-equal actual vendor system prompt. These carry unique lower contracts only after green candidate. No test-only production hooks introduced.

## Batch28 and native literal-ID startup defect

Root batch28 original two workflows and actual Git preparation/replay all green, types green. Literal-ID scenario correctly remained red and old wildcard declaration remains retained. First two IDs execute; star* instead failed before intended missing-file guard with `Expected an unchanged canonical grant path`. Diagnosis: public definition permits literal star ID; encodeURIComponent leaves `*` unchanged in kernel-worker configuration filename; residentLauncher grants that real config path; strict canonicalGrant correctly refuses wildcard path. Explicit project workspace does not remove the separate config-read grant.

Small production repair encodes literal star as `%2A` in the generated ephemeral worker-config filename. No sandbox grant weakening or broader permission. Public node identity, operation IDs, sessions and visible names stay literal. Keeper now explicitly uses project workspace (target contract is literal IDs in queue generations, not Git branch names) and names each ID in failures. Batch28 is real failing control; candidate native execution needs root verification. Old wildcard/generation proof stays until actual valid native submit then intended post-submit missing-file failure is proven for all four IDs.

Batch28 three successful new owners additionally retire four direct declarations: hand-inserted prompt view now actual before-null/active/native-wire bytes in public keeper; malformed private create now actual public graph-definitions atomic table counts (private duplicate graph-ID create path has no production caller, public request replay is the real product contract); fake prepare-callback recovery now real missing-branch repair same-request replay; private inspect inventory now real public summary/nodes/revision/edge history. The uncalled inspect `{kind:'deliveries',executionId}` branch had only that inventory test as caller; real management inspect already exposes queue/edge/execution/results, so retire this test-only branch and narrow the type. Other fixture users still need GraphRuntime.create/deliver, which remain. Remaining eight declarations kept until exact native proof; literal-ID declaration remains until encoding repair candidate and control pass.
