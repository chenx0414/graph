# Independent preservation review 41 — tool channel

Decision: **the three old tool-channel declarations can retire after the restored keeper rerun; no unique current public contract is lost.** Current `tests/e2e/node-submit.test.ts` genuinely absorbs their useful behavior. This review is read-only; no tests executed or repository files edited by reviewer.

Read full old `tests/m8/tool-channel.test.ts`, full current native node-submit keeper and `/tmp/graph-tool-channel41-plan.md`; actual `node-submit-bridge.ts` including hostSubmitCall and NodeSubmitBridge; production resident host request/result routing, resident worker forwardingTools; native graph config/tool callback/event recording; task-runtime's actual hostSubmitCall wiring; installed Pi agent-loop's prepareToolCall unknown-tool path; full sibling `tool-failure-record.test.ts`; full fixture resident host + worker entry; history b01cb33 statistics; remaining fixture callers. Existing source/test audit instructions read. Issue-number strings in legacy comments are treated as existing source context; no GitHub operation or new issue identity inference performed.

## Old-to-current ledger

| Old declaration | Preserved current observable proof | Assessment |
| --- | --- | --- |
| T1/T5 node call reaches host and returns model answer | Real model sends submit n7; actual production hostSubmitCall invokes current execution's real kernel; receiver gets exactly n7 once, graph results n7, sender single actual execution has submission_id. Requests6 and7 parse actual host success receipt exactly `{accepted:true,deliveries:1}` and correlate prior submit call IDs. | Stronger. Old callback fabricated accepted/sub-1 and only asserted called arguments + two model requests; it never asserted returned receipt. Current real kernel, process channel and next provider request own proof. |
| T2 refusal correctable rather than crash | Invalid protocol/enable:false calls yield real structured next-request `missing_required_output` and `enable:true` guidance, empty deliveries before valid submit, then same execution completes with real n7 delivery. Existing identical replay and second-different refusal remain. | Preserved and stronger. Old stub supplied two canned replies, checked callback count and provider count; no error body or owner state asserted. Current does not need a new throw-only fixture. |
| T3 undeclared call refused, never forwarded as a callable tool | External model asks not_a_tool; actual first provider request declares submit and omits not_a_tool; actual following request contains exact SDK `Tool not_a_tool not found` with `tool_call_id: unknown-tool`; runtime persists error result and later assistant final answer, node succeeds and n7 remains. | Preserved at real boundary. Installed prepareToolCall immediately rejects an absent tool before beforeToolCall or execute; forwardingTools creates entries only for declared/allowed names. Actual host fallback message is different (`the host does not offer a tool named ...`). Thus exact SDK rejection + absent declaration proves the relevant no-offered-tool route, while current code inspection explains why host execute is bypassed. Do not add a test-only callback merely to assert zero private invocations. |

The five T labels in the old header are not five declarations. T4 had no standalone body; failure reason persistence remains owned by the untouched genuine daemon/native `tests/m8/tool-failure-record.test.ts`. Unknown result persistence in node-submit does not replace that human/machine-readable reason contract.

## Fixture authenticity and indexing

External fixture supplies model tool requests only. It does not supply accepted receipts, execution IDs, submission state, delivery state or completion receipts. The native public runtime and real resident host/worker create all those facts. `inspectEdge` merely reads actual graph state while each vendor response is about to arrive. Snapshots0..4 remain empty; all later snapshots retain exactly n7. Existing plans0..7 remain; index8 asks unknown tool; index9 carries unknown tool result and receives final answer. Sender10 and receiver1 are consistent with these real requests. Positive guards explicitly prove submit is declared before negative unknown-tool omission.

## Evidence independently inspected

- `/tmp/graph-test-audit-tool-channel41.log`: 3 files, 5 tests passed, 3.42s, 15:32:01. This is candidate proof, before retirement. It is not full-suite or post-mutation-restoration proof.
- `/tmp/graph-test-audit-typecheck41.log`: empty; root reported success. An empty file alone does not independently prove command exit status, so retain root's process exit evidence for typecheck claim.
- `/tmp/graph-tool-channel-control41-success-receipt.log`: intended red at native node-submit line53, actual corrupted `{accepted:false,deliveries:0}` versus expected real receipt. Guards actual reverse-channel answer independently of kernel's successful delivery.
- `/tmp/graph-tool-channel-control41-refusal-receipt.log`: intended red line49, `CORRUPTED_REFUSAL_RECEIPT` does not contain missing_required_output. Demonstrates next-wire refusal content assertion is live.
- `/tmp/graph-tool-channel-control41-unknown-record.log`: intended red line68, persisted unknown-tool error result missing while other results/final assistant message remain. Demonstrates new result persistence guard is live.
- `/tmp/graph-tool-channel-controls41.json` records all 3 controls exited1 with restore hashes. Current actual source SHA256 independently equals those records: resident-worker `39f76ad4ae965a3b8c8eee645f70c17bf4f75c34e836bc25a5dac859c480ade8`, kernel-graph-lane `6623029e3d53674d8657be0b1b6fb77af137626d9a54c0006c3feb4501bcd6d2`.

No preservation gap found, no new assertions required by this review. Root should run restored keeper + genuine sibling(s), retire only old tool-channel file, then usual changed checks. Installed dependency mutation is not necessary to justify deleting a callback-count probe; real native positive unknown-tool execution plus inspected dependency route already establishes it. Existing three intentional controls cover all newly added owned transport/persistence guards.

## Cleanup boundary

Delete only old tool-channel test file. `tests/fixtures/resident-host.ts` and its worker entry retain actual callers in spike-resident-worker, resident-transport and spike-config-rebind; do not remove them in this cutover. Production resident onToolCall and forwardingTools have real native lane callers and remain required. No new production seam or API is unlocked for deletion here. No change to existing e2e bodies, graph completion behavior, provenance or runtime policy is needed.
