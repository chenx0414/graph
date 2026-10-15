# Console inventory lane 34 — no whole-file E2E exclusions

Read all ten files completely (1,466 lines); no source, tests or executable manifests edited; no Vitest run. No assigned whole file qualifies for coverage exclusion in its current state. JSON entries is deliberately empty. File hashes and declaration names identify exact reviewed bytes. Names containing e2e do not override the actual boundary.

## Owner and fixture evidence

Read full console test sources and their in-file fixtures. Full external OpenAI fixture and server/host entry were already read in prior lane. Reviewed agent-messaging.ts and conversation-tools.ts in full, agent-tools peer tool factory handlers, full conversation-projection.ts, conversation.ts delta/stream/activity/checkpoint/output/interruption owners, task-runtime.cancelMessage, operation lifecycle report/settle/transient retry paths, question-routing.insertQuestion and native wake/owner branch, artifact workspace visibility query/listProject/list/read integrity path. Native graph owner public runtime entry contracts and SDK handoff architecture were established in campaign and prior reviews; context-model invokes them without replacing their business behavior. Test routing remains base tests/**/*.test.ts plus reviewed whole-file manifests; none of these ten should be added wholesale based on this review. Inspected latest historical commit for context/prereview sources.

SQL reads of real producer effects are fine; the problem in these candidates is SQL writes inventing graph state or bypassing actual producers, not the presence of a store connection. Likewise an external vendor response fixture is permitted, while fabricating ActionAdapter outcomes is not the same boundary.

## Per-declaration ledger

### tests/console/agent-messaging-e2e.test.ts

SHA256 `2e48112d06e7cf0f67f6121591fc0af35f16975ca866b2bbbb421c40bb5757c9`; fully read; 1 declarations; lower_layer.

1. **R contract — migrate actual producer/boundary** `a worker is offered list_peers and send_to_peer, and no inbox: a peer message arrives as a prompt` (line 15): SQL invents projects/tasks/conversation/nodes and agentTools receives fake peers.send; direct tool.execute bypasses actual worker/native delivery.

### tests/console/artifact-conversation-scope.test.ts

SHA256 `0afdaf02facb56d3bb052140ab2a18f0cd41070220af270b4f5803d67cc5d924`; fully read; 2 declarations; lower_layer.

1. **R contract — migrate actual producer/boundary** `a task reads the task-scope artifacts of every task in its own conversation, and nothing across conversations` (line 58): SQL invents conversation/task scope; low-level ArtifactWorkspace.publish uses fabricated producer identities; no real node publication.
2. **R contract — migrate actual producer/boundary** `promotion is still a separate, explicit act and still lands in project scope` (line 93): SQL invents conversation/task scope; low-level ArtifactWorkspace.publish uses fabricated producer identities; no real node publication.

### tests/console/human-prereview-e2e.test.ts

SHA256 `c38eae7290c7cf470411173e30c5e4699e37e6a5b95c8cdb5d8dcabea3d8091a`; fully read; 1 declarations; mixed.

1. **R contract — migrate actual producer/boundary** `a human acceptance check wakes the master, whose own turn carries the review tools` (line 57): real native master request but SQL fabricates graph task/blocked acceptance node/budget; internal insertQuestion directly creates trigger instead of real acceptance owner.

### tests/console/transient-retry-e2e.test.ts

SHA256 `2a7b7ca2308926203363631f8baa255b0de303f060d231df930759509d04e745`; fully read; 4 declarations; lower_layer.

1. **R contract — migrate actual producer/boundary** `a network blip retries itself: node goes back to pending, nobody is woken` (line 63): SQL seeds task/node/instance/activation and directly calls OperationLifecycle.admit/dispatch/report with invented failure result.
2. **R contract — migrate actual producer/boundary** `a real compile error wakes main on the first failure, with the verdict recorded` (line 76): SQL seeds task/node/instance/activation and directly calls OperationLifecycle.admit/dispatch/report with invented failure result.
3. **R contract — migrate actual producer/boundary** `the bound holds: the third blip wakes main and says the retries ran out` (line 87): SQL seeds task/node/instance/activation and directly calls OperationLifecycle.admit/dispatch/report with invented failure result.
4. **R contract — migrate actual producer/boundary** `a failure with no error text is not treated as a blip: main gets it immediately` (line 102): SQL seeds task/node/instance/activation and directly calls OperationLifecycle.admit/dispatch/report with invented failure result.

### tests/console/conversation-activity.test.ts

SHA256 `f9dc9984ac4a5ba69ea9af6af5ee7d697fe0302895a8add505c938b2e717bdb4`; fully read; 4 declarations; lower_layer.

1. **R contract — migrate actual producer/boundary** `turn activity keeps narration and tool calls in the order they happened` (line 4): direct conversationActivityRecords with manufactured narration/tool arrays.
2. **R contract — migrate actual producer/boundary** `the narration that is the final reply is dropped, not shown twice` (line 17): direct conversationActivityRecords with manufactured narration/tool arrays.
3. **R contract — migrate actual producer/boundary** `older operations keep their plain tool activity shape` (line 24): direct conversationActivityRecords with manufactured narration/tool arrays.
4. **R contract — migrate actual producer/boundary** `turn activity keeps the ordinal that orders it in the transcript` (line 30): direct conversationActivityRecords with manufactured narration/tool arrays.

### tests/console/conversation-queue.test.ts

SHA256 `e930e5f75ec13fbd9b1a478dd77e06043ecbf06bff770eab80f9401d822817ad`; fully read; 3 declarations; mixed.

1. **R contract — migrate actual producer/boundary** `queued messages can be cancelled one by one without disturbing the running turn` (line 37): gated fake master ActionAdapter supplies asserted turn completion; direct runtime calls.
2. **R contract — migrate actual producer/boundary** `cancelling an unknown or foreign message is a no-op` (line 96): public cancellation isolation path uses real paused runtime state but fixture still installs unused fake master action; move to real native/full runtime keeper before routing whole-file.
3. **R contract — migrate actual producer/boundary** `the cancel endpoint keeps the POST + requestId contract over HTTP` (line 120): createApp is invoked in-process through app.inject, never listens on real HTTP; fake master action retained in fixture.

### tests/console/conversation-stream.test.ts

SHA256 `be3da35655d6ec2ddc34f73d24d7a2f60a35edde7aee06f424c4e5a68a400cf5`; fully read; 7 declarations; lower_layer.

1. **R contract — migrate actual producer/boundary** `live deltas persist a recoverable snapshot and append only the new suffix` (line 30): SQL invents active operation plus direct publishConversationDelta/persistConversationActivity/recordConversationOutput/interruption with fabricated operation/results.
2. **R contract — migrate actual producer/boundary** `two text parts of one operation stay apart and come back in turn order` (line 78): SQL invents active operation plus direct publishConversationDelta/persistConversationActivity/recordConversationOutput/interruption with fabricated operation/results.
3. **R contract — migrate actual producer/boundary** `a settled turn records its narration and tool calls in the order they happened` (line 96): SQL invents active operation plus direct publishConversationDelta/persistConversationActivity/recordConversationOutput/interruption with fabricated operation/results.
4. **R contract — migrate actual producer/boundary** `an interrupted operation that already delivered its reply adds no error notice` (line 129): SQL invents active operation plus direct publishConversationDelta/persistConversationActivity/recordConversationOutput/interruption with fabricated operation/results.
5. **R contract — migrate actual producer/boundary** `the reply marker is explicit on the operation, not inferred from message rows` (line 145): SQL invents active operation plus direct publishConversationDelta/persistConversationActivity/recordConversationOutput/interruption with fabricated operation/results.
6. **R contract — migrate actual producer/boundary** `reload receipt does not discard the completed operation activity` (line 164): SQL invents active operation plus direct publishConversationDelta/persistConversationActivity/recordConversationOutput/interruption with fabricated operation/results.
7. **R contract — migrate actual producer/boundary** `activity checkpoints survive a worker stop and keep parallel tool states separate` (line 177): SQL invents active operation plus direct publishConversationDelta/persistConversationActivity/recordConversationOutput/interruption with fabricated operation/results.

### tests/console/conversation-tools.test.ts

SHA256 `5fbd7504d64ba615e572d14795c234fa70203fab596bc72276e8be6dace1d737`; fully read; 4 declarations; lower_layer.

1. **R contract — migrate actual producer/boundary** `a write needs full access, and that is the only door it needs` (line 10): direct refusal/format helpers or openConversationTools with fake service returning asserted handoff/read receipts.
2. **R contract — migrate actual producer/boundary** `agents talk freely: a reply back is a message, and one turn may send as many as it needs` (line 19): direct refusal/format helpers or openConversationTools with fake service returning asserted handoff/read receipts.
3. **R contract — migrate actual producer/boundary** `a message written by an Agent says so, so the target never mistakes it for the user` (line 44): direct refusal/format helpers or openConversationTools with fake service returning asserted handoff/read receipts.
4. **R contract — migrate actual producer/boundary** `read asks for the newest window unless a cursor says otherwise` (line 53): direct refusal/format helpers or openConversationTools with fake service returning asserted handoff/read receipts.

### tests/console/conversation-projection.test.ts

SHA256 `2673f952ab165f981f4e21cb27b6b245ac5f9d4c155bdb346337073a24de8fd0`; fully read; 16 declarations; lower_layer.

1. **R contract — migrate actual producer/boundary** `stable IDs keep the newest record and ignore stale history` (line 36): pure projection reducer with manufactured messages/snapshots/events; no real browser, HTTP or native lifecycle.
2. **R contract — migrate actual producer/boundary** `history requests first fill older records and then sweep a burst hole forward` (line 55): pure projection reducer with manufactured messages/snapshots/events; no real browser, HTTP or native lifecycle.
3. **R contract — migrate actual producer/boundary** `an empty before page switches to the forward sweep when the earliest record has a global sequence gap` (line 79): pure projection reducer with manufactured messages/snapshots/events; no real browser, HTTP or native lifecycle.
4. **R contract — migrate actual producer/boundary** `live deltas and tools disappear when durable records arrive, while queued messages stay visible` (line 100): pure projection reducer with manufactured messages/snapshots/events; no real browser, HTTP or native lifecycle.
5. **R contract — migrate actual producer/boundary** `tool records render before the final assistant answer for the same turn` (line 136): pure projection reducer with manufactured messages/snapshots/events; no real browser, HTTP or native lifecycle.
6. **R contract — migrate actual producer/boundary** `terminal operation events discard abandoned live output without touching the active attempt` (line 151): pure projection reducer with manufactured messages/snapshots/events; no real browser, HTTP or native lifecycle.
7. **R contract — migrate actual producer/boundary** `an uncertain operation also ends its live stream so the answer stops flashing` (line 175): pure projection reducer with manufactured messages/snapshots/events; no real browser, HTTP or native lifecycle.
8. **R contract — migrate actual producer/boundary** `interrupted retries do not push the durable final answer above stale stream rows` (line 186): pure projection reducer with manufactured messages/snapshots/events; no real browser, HTTP or native lifecycle.
9. **R contract — migrate actual producer/boundary** `length-checked append deltas extend in place and recover from a snapshot after desync` (line 218): pure projection reducer with manufactured messages/snapshots/events; no real browser, HTTP or native lifecycle.
10. **R contract — migrate actual producer/boundary** `a live turn keeps its two text parts apart, in the order they happened` (line 278): pure projection reducer with manufactured messages/snapshots/events; no real browser, HTTP or native lifecycle.
11. **R contract — migrate actual producer/boundary** `a reconnect keeps every part and its ordinal` (line 298): pure projection reducer with manufactured messages/snapshots/events; no real browser, HTTP or native lifecycle.
12. **R contract — migrate actual producer/boundary** `a settled operation drops every live part, not just the first` (line 312): pure projection reducer with manufactured messages/snapshots/events; no real browser, HTTP or native lifecycle.
13. **R contract — migrate actual producer/boundary** `snapshot does not resurrect settled live text and ignores replayed deltas` (line 326): pure projection reducer with manufactured messages/snapshots/events; no real browser, HTTP or native lifecycle.
14. **R contract — migrate actual producer/boundary** `snapshot cursor filters old events and an in-flight snapshot cannot erase newer text` (line 336): pure projection reducer with manufactured messages/snapshots/events; no real browser, HTTP or native lifecycle.
15. **R contract — migrate actual producer/boundary** `a fresh tail snapshot cannot swallow an older cached message update in flight` (line 345): pure projection reducer with manufactured messages/snapshots/events; no real browser, HTTP or native lifecycle.
16. **R contract — migrate actual producer/boundary** `message image attachments retain their payload for rendering after reload` (line 352): pure projection reducer with manufactured messages/snapshots/events; no real browser, HTTP or native lifecycle.

### tests/console/context-model.test.ts

SHA256 `e320ec25db3f0c3aafe02f9f68267d9cac3d923df970e37ce157b6219ac3e193`; fully read; 14 declarations; mixed.

1. **R contract — migrate actual producer/boundary** `native definitions reject legacy transcript-inheritance context instead of pretending it changes the session` (line 21): pure parser helper: valid baseline plus 2 fabricated legacy context rejection rows.
2. **R contract — migrate actual producer/boundary** `native definitions reject inferred predecessor handoffs and legacy dependency scheduling fields` (line 29): pure parser helper: 2 predecessor context rejection rows plus dependsOn/when/container (5 rows).
3. **R — genuine workflow, retain** `new native nodes have independent sessions and quotas, and a later source turn cannot charge or copy into its peer` (line 71): public runtime graphCreate/graphSend/graphPatch plus real native model/worker/tool invocation, durable read/reopen and external model HTTP fixture only.
4. **R — genuine workflow, retain** `a receiver initial turn contains its task, acceptance, named protocol and explicit value without the sender private reply` (line 86): public runtime graphCreate/graphSend/graphPatch plus real native model/worker/tool invocation, durable read/reopen and external model HTTP fixture only.
5. **R — genuine workflow, retain** `an explicit evidence projection excludes the source summary and transcript from the receiver actual turn` (line 99): public runtime graphCreate/graphSend/graphPatch plus real native model/worker/tool invocation, durable read/reopen and external model HTTP fixture only.
6. **R — genuine workflow, retain** `a declared artifact-reference protocol rejects a missing version before downstream dispatch and retains the failed input for main` (line 112): public runtime graphCreate/graphSend/graphPatch plus real native model/worker/tool invocation, durable read/reopen and external model HTTP fixture only.
7. **R — genuine workflow, retain** `an explicit artifact version remains the receiver context after the same logical publication advances` (line 127): public runtime graphCreate/graphSend/graphPatch plus real native model/worker/tool invocation, durable read/reopen and external model HTTP fixture only.
8. **R — genuine workflow, retain** `native interface values do not silently invent a digest, absolute path or published artifact for a private file` (line 142): public runtime graphCreate/graphSend/graphPatch plus real native model/worker/tool invocation, durable read/reopen and external model HTTP fixture only.
9. **R — genuine workflow, retain** `a real publication outside the private work copy is refused without leaking the host file to downstream` (line 153): public runtime graphCreate/graphSend/graphPatch plus real native model/worker/tool invocation, durable read/reopen and external model HTTP fixture only.
10. **R — genuine workflow, retain** `a real workspace-relative publication gives the receiver verified bytes and a stable digest without copying private file paths into its context` (line 166): public runtime graphCreate/graphSend/graphPatch plus real native model/worker/tool invocation, durable read/reopen and external model HTTP fixture only.
11. **R — genuine workflow, retain** `changing the native node recipe takes effect on its next turn through a rebind that retains only its own history` (line 181): public runtime graphCreate/graphSend/graphPatch plus real native model/worker/tool invocation, durable read/reopen and external model HTTP fixture only.
12. **R — genuine workflow, retain** `two instances of one native subgraph template retain independent conversations when one is activated again` (line 199): public runtime graphCreate/graphSend/graphPatch plus real native model/worker/tool invocation, durable read/reopen and external model HTTP fixture only.
13. **R — genuine workflow, retain** `a reopened native node resumes its recorded own history and receives only the new input delta on its next execution` (line 213): public runtime graphCreate/graphSend/graphPatch plus real native model/worker/tool invocation, durable read/reopen and external model HTTP fixture only.
14. **R — genuine workflow, retain** `an unsupported transcript-inheritance patch is refused atomically and the existing native session remains usable` (line 227): public runtime graphCreate/graphSend/graphPatch plus real native model/worker/tool invocation, durable read/reopen and external model HTTP fixture only.

## Precise migration opportunities and preservation requirements

- **context-model:** first two parser declarations have 7 rejected legacy settings total: 2 transcript-inheritance context payloads, 2 predecessor handoff payloads, dependsOn, when, container. Carry each into an existing actual graph creation/patch atomic-refusal keeper, with a valid public graph positive baseline, independent refusal reason and unchanged active revision/session. Only after that, retire first two declarations or move the remaining twelve genuine workflows unchanged to a dedicated whole-file E2E owner. Existing final patch refusal case covers one context variant, not automatically all 7 distinct settings.

- **agent messaging:** real graph-messages native keeper is the natural owner. Preserve actual worker declarations list_peers/send_to_peer and absence of read_peer_messages, graph-only address list, delivery to pending recipient as prompt, no separate pollable inbox, exact payload/requestId. Existing helper test itself invokes a fake send returning state rework; do not call that durable delivery. Determine whether peerNodes legacy projection has a production caller before retiring it; code comment says native graph lane supplies its own address list.

- **artifact scope:** use actual main conversation creating sibling graphs and real worker artifact_publish; main and sibling read bytes from same conversation, another conversation (prefer same project as positive scope control) cannot read, a task without conversation retains isolation if still publicly reachable. Promotion remains explicit and creates project scope; same-conversation read must not silently promote. Existing artifact-publication keeper may absorb parts after exact comparison, but these tests are not made E2E by real files alone.

- **human prereview:** real native request currently proves review tool declarations/wake briefing, but trigger is artificial. Reach a human acceptance requirement through a real graph completion/check flow, observe main wake carries exact reason and both review tools; main reviewing must leave user ownership/open check and no human.accepted event. Avoid recreating removed legacy program graph.human_check nodes through SQL.

- **retry:** run actual failing external model/command through native owner. Preserve transient first and second retries with durable reason/counter and no question, third failure exhausted with main problem, compile error immediate nonretry, null/no-text failure immediate nonretry if production can genuinely emit it. Current test invokes the legacy OperationLifecycle directly; map whether current native graph lane uses this exact retry policy before claiming replacement.

- **queue:** strongest existing real paused/held-native conversation lifecycle keeper can carry one-by-one cancel, command requestId replay, running turn untouched, FIFO survivor processing, delivered/cancelled no-op with null cursor, foreign/missing isolation, empty messageId rejection. Replace app.inject declaration with listening host + actual fetch including session/origin and exact idempotent response. Do not preserve fake action just to classify unexecuted fixture.

- **activity/stream:** real native tool/narration execution and held external stream should prove ordered narration/tools, final narration dedup, tool error state, ordinals, two text parts around a tool, live suffix/full snapshot recovery, terminal unknown/succeeded no active streams, final idempotence, replied_at separate from user rows, post-reply stop no contradictory notice, checkpoint activity surviving actual worker stop, and parallel tool states. Old plain toolActivity compatibility is an independent migration/storage contract until proved obsolete, not disposable because it is old.

- **projection:** retain public effects of stale-history merge, gap/burst/interleaved pagination, queued chip visibility, tool-before-final ordering, abandoned vs active attempt isolation, terminal unknown cleanup, length desync recovery, multipart live/reconnect/settle, snapshot cursor stale/new stream races, old cached pending→delivered update after newer tail, and image bytes after reload. Browser history/image keepers already provide some; exact stale/in-flight races need actual transport delay of real responses or stream interruption rather than synthetic business DTO. Pure object reference equality and helper layout need not be preserved if public semantics remain.

## Status

No deletions authorized by this report alone. The whole-file E2E candidate set is zero; twelve individual context workflows are retainable genuine E2E. Root owns moves, actual keeper checks and any eventual routing update, with exact SHA comparison and frozen checkout.
