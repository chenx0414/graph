# Tool channel migration 41: extend the primary native submit keeper

Read-only preparation. No repository mutation and no Vitest run. Candidate `/tmp/graph-tool-channel41.test.ts` is a complete replacement **candidate for tests/e2e/node-submit.test.ts**, not a proposed additional suite. It keeps the original one declaration and its native public runtime setup. Apply by extending that keeper, then delete the original three tool-channel cases after proof/preservation/controls. Net reduction3 cases; new keeper remains1 case.

## Sources read

- All original tests/m8/tool-channel.test.ts3 bodies (history b01cb33).
- Existing tests/e2e/node-submit.test.ts full; graph-definitions native setup and graph-completion-e2e legacy composition; tests/m8/tool-failure-record.test.ts full.
- Production task-runtime actual native lane tool callback; kernel-graph-lane config plus complete onToolCall/event owners; node-submit-bridge entire; kernel submit required-output transaction; native NodeRun projection.
- Production resident-host and resident-worker entire, resident-worker-entry, historical fixture resident-host and fixture entry.
- Installed Pi SDK agent-loop execute/prepare tool calls and AgentSession tool hooks. Unknown name is rejected **before** beforeToolCall or tool.execute, with immediate `Tool <name> not found` error result. Runtime records SDK end event; next model request contains this result.

## Ledger and primary owners

T1/T5 -> C existing native submit keeper. Original scripted onToolCall callback returned accepted/sub-1 without kernel receipt. Original assertions only call count/name/args and2requests; they never asserted host receipt actually reached next provider. Production hostSubmitCall public receipt is `{accepted:true, deliveries:<count>}`; submissionId is internal/public execution history, not host tool response. Candidate parses both actual successful next-wire receipts exactly `{accepted:true,deliveries:1}`, correlates their tool_call_id to prior valid/replay calls, retains real routed n7 and receiver execution/result. These values are produced by real kernel operation and actual host/worker transport; fixture only supplies external model tool requests. It does not assert fictional sub-1.

T2 -> C existing native submit keeper. Already sends out.enable:false after protocol defects, observes exact next-wire `missing_required_output`, `enable:true`, then succeeds and replays. Keep all original assertions. Existing snapshots prove invalid calls leave no delivery; later real valid output delivers7 once; final completed operations prove same running node can correct. Additional sender.operations length1 and submission_id string establish the valid submission really belongs to that single actual execution. No fabricated state or direct owned submit callback.

T3 -> C extend native submit keeper with an unknown external model tool request after its existing second-different-submit refusal and before final answer. This adds one provider request within the same test/execution, not a redundant new fixture or case. Candidate asserts next wire exact `Tool not_a_tool not found`, matching tool_call_id unknown-tool, real provider-declared tools include submit and omit not_a_tool, persisted node record contains an error result for unknown call, and actual final assistant message exists with node succeeded. Existing original delivery remains7 and receiver runs once. SDK rejects unknown before the registered execute callback by source, so this is the actual no-offered-tool path. No claim that Graph's host callback was invoked or that this is a kernel submit refusal.

T4 in comment had no independent original test. Tool-failure-record remains untouched, owning persistent human-readable/machine-readable failure reason from actual failing native read; no duplicated error persistence matrix needed. Candidate unknown event assertion exists to show unknown error is not silently omitted, not to rerun missing-file diagnosis.

## Candidate index map

Original submit plans indexes0..7 unchanged, final answer moves8->9. New index8 response requests not_a_tool. Therefore:
- next-wire success receipts remain request6 (submit5) and7 (submit6 replay)
- request8 still carries already_submitted error from submit7
- request9 carries unknown-tool not-found result then receives final text
- sender10requests, receiver1
- snapshots extra last entry still original n7 delivery; first5 remain empty

## Deliberate controls suggested

1. In resident-worker forwardingTools successful answer, replace forwarded text with a wrong receipt (`accepted:false` or deliveries0). Candidate must fail parsed success receipt guard (the real kernel state may still succeed, demonstrating distinct transport proof).
2. In resident-worker tool_result command handler, corrupt a refused answer's text or mark ok:true. Existing disabled-output/error guard in next wire must fail for intended missing_required_output/enable:true; be careful conditional mutation targets missing-required only so an earlier schema validation doesn't fail first.
3. In runtime native onEvent handler skip unknown-tool execution_end: candidate must fail persisted unknown result guard, while next-wire error still exists. This checks newly carried observable omission risk; original T3 had no such persistence assertion.
4. Unknown-tool SDK rejection is an installed dependency path, not an independent Graph algorithm. Do not add a new production hook only to mutate it. Candidate's real model unknown call + real next-wire error and eventual continuation is direct positive evidence. If a deliberate gate control is needed, mutate installed SDK immediate unknown result only with byte backup/restore, clearly label dependency mutation and do not commit node_modules. Prefer no dependency mutation unless campaign requires it.

Every mutation must restore bytes before any subsequent unrelated test and rerun candidate unchanged. Root owns all Vitest runs and frozen checkout. No green result claimed here; new exact receipt/tool_call_id assertions need root runtime proof.

## Limits and seam cleanup

Do not remove tests/fixtures/resident-host.ts or fixture worker entry based solely on retirement of tool-channel: other resident spike cases still use them (root should rg remaining callers after deletion). No production API removal is unlocked by this coherent batch; resident-host.onToolCall has a genuine lane caller. No new production exports/flags/injections needed. Do not alter existing graph-completion mixed fixture proof in this batch.
