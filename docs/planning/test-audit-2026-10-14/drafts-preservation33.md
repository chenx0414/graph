# Draft lifecycle independent preservation review — batch 33

Read complete tests/e2e/conversation-drafts.test.ts and docs/planning/test-audit-2026-10-14/conversation-drafts.md; read all 16 mapped original declarations in tests/m8/conversation.test.ts including their full shared fixtures, workflowDraft/nativeWorkerRuntime/scripted owners. Read adjacent unmapped decision snapshot and explicit empty-decision declarations to verify they remain out of scope. Read task-runtime proposal/view/bind/confirm/archive/restore/delete/propose/withdraw owners, native tool handlers and actual conversation HTTP forwarding. No source/test/routing edits or Vitest runs by reviewer.

Root reports batch 33b: 6 files / 39 cases passing, including all four new draft workflows. This review independently assesses source preservation; it does not claim the reviewer executed those tests.

## Result

One small content-preservation carry is required before retiring all 16: after B's restore-draft-1 click, assert the restored proposal still has original summary **First version** before the next native edit overwrites it. Existing wait checks only version=1. The old archive/restore and restore-current declarations explicitly assert original content immediately after restore. A restoration that put the correct version in front while corrupting/replacing its summary could currently pass after f.draft replaces that summary. Root notified.

Suggested existing owner assertion: poll the actual HTTP view proposal for { version:1, spec:{summary:'First version'} } immediately after restore and before f.draft('Restored first version edited'). Checking active history[1]/archived[2] at the same point is useful but their eventual exact post-edit assertions already exist. No new declaration or fixture seam is needed.

With that assertion added and passing, no other sole contract from the mapped 16 is missing in the reviewed source. In particular, separate A confirmation of edited same v1/rev2 preserves the successful new credential path; moving directly to explicit v2 would not have sufficed.

## Exact mapping and evidence

| Original declaration | Keeper | Independent preservation finding |
|---|---|---|
| explicit newVersion keeps draft history and only the latest can be confirmed | A | v1→v2 actual native tool requests, exact summaries/history/accepted/stale flags, by-version read and missing99, old/latest repeat stale refusal, positive current confirmation, requirement advance, task list excludes anchor, exact idle work/no queued inputs, real related task graphVersion1/origin v2, operation module/edge survive. Extra receipt replay is real. |
| editing a draft in place replaces its content without stacking versions | A | first revision1/digest valid, same version revision2/different digest, sole history[1], edited v1 read after explicit v2. Independently authored summaries establish actual replacement. |
| a confirmation credential from replaced draft content is refused | A | same-version old credential fails; separate conversation confirms actual revised v1/rev2 with exact accepted revision and sole task. Actual valid main branch exists, so stale guards are not masked by Git preparation/branch rejection. |
| archive hides a draft from the active list and restore brings it back | B | actual browser archive plus HTTP archive, current/history empty, exact archived identities, by-version archived/readable content, main graphState and formal task view agree, archived confirm refused. **Add immediate restored original summary before edit.** |
| deleting a draft hides it but never removes the graph it started | C | actual native worker submit, positive real entries/session and acceptance, terminal module observed before snapshots, deletion hides all source lists/by-version route; exact messages/worker entries/session/acceptance/revision and task identity retained. Stronger than old count-only comparisons; snapshots hold independently produced real evidence. |
| a confirmed draft is never overwritten by a later task or a rebinding | D plus A | frozen confirmed native graph name/task and source by-version summaries survive later proposed/confirmed tasks and B→A rebind; original formal task project B retained. Version/requirement offsets differ due initial rebind but same actual lifecycle invariant. |
| a deleted or archived version is never handed out again | B | archived v2 remains readable, restored v1 edit stays same identity, explicit v3 skips archived high-water, delete v3, default v4 skips tombstone; exact active[1,4]/archived[2]. Default allocation is at least as strong as original explicit newVersion after deletion. |
| a deleted draft version is never handed out again | B | default post-delete draft allocates4 rather than reusing deleted3; explicit expected summary and exact history preserve new identity. Existing older v1 does not bypass the tested deleted current pointer/high-water path. |
| restoring an archived draft makes it current again without stacking versions | B | both cards archived, native model/API/main visibility, restore v1, default edit v1/rev2, exact active[1]/archive[2], explicit v3. **Add immediate First version restored content assertion.** |
| post-confirmation chat keeps the requirement fixed and sees real execution status | C | actual native main request carries asked question/task identity/Feature task/work:idle, actual worker executes, next actual main request work:succeeded; requirement fixed2 after both. Replaces old fake main context inspection with actual wire. |
| a scope change after confirmation becomes a new queued task, not an edit of the running one | D | distinct accepted task IDs in exact order, phases running/queued, unchanged first task's acceptedProposalVersion/acceptance descriptions/phase; requirement4 accounts for initial real project rebind. |
| rebinding a conversation invalidates drafts investigated for the previous project | D | real A→B bind, invalidatedDrafts true, project B/requirement2/old stale, stale confirm guard; positive new B draft confirmation carries formal task project B. |
| a confirmed task carries the conversation decisions and constraints to its workers | C | first actual worker provider request contains independently authored original Chinese constraint and Decisions and constraints header; real native worker submit proves execution. |
| the conversation status stays with the master while the constraints still reach the workers | C | same positive real worker constraint/header and negative Conversation and execution status header, while native main status independently positively observed. |
| the master can withdraw its own unconfirmed draft without losing it | B | actual native withdraw tool result for missing/current/repeated guard, successful JSON receipt withdrawn4/next5, current null/history retains4/system notice reason, stale confirm, next actual draft6. Guard messages exactly match owner and are observed as genuine SDK tool results, not fixture fabricated receipts. |
| draft cards belong to their own conversation and never leak across | D | two native-produced drafts, second archive leaves first own summary/archive[] intact; second current null/archive[1]. Same project setup controls project effects and isolates conversation ownership. |

## Authenticity and vacuity checks

- Main provider queues emit propose_graph/withdraw_draft at the external vendor boundary; installed native SDK/tool handlers and production owners create actual receipts/state. turn finds the matching tool_call_id in genuine follow-up request before interpreting result. There is no ActionAdapter, SQL insertion, fake graph event, route-fulfilled business response, owner predicate import or source grep.
- Actual HTTP calls obtain a cookie through the real home page and send origin via browser context headers. Real clean Git projects with actual main branches make refusal assertions reach intended stale/not_found guards.
- Worker no-request assertions follow positive native main draft and confirm effects; C separately proves the same worker provider does receive two requests on explicit input. The idle/no-request confirmation contract is not inferred from an entirely unconfigured runtime.
- C's snapshots are suitable preservation comparisons: entries/session/acceptance are independently created by the actual native worker before deletion and positive nonempty assertions prevent vacuous []==[]. The revision comparison preserves real frozen graph; A/D independently assert its expected meaning. It is not subject-generated expected data for a newly fabricated result.
- C deliberately allows terminal check operation settled OR failed. The mapped old contract is acceptance record preservation through source deletion, not command success; original old declaration only required nonempty acceptance and worker success. New keeper still requires successful worker submit and nonempty acceptance. Do not describe the check as passed in delivery notes unless separately verified.
- Native guard message fragments are independent outward error contracts. Fixed Chinese UI labels and exact summaries protect visible behavior rather than identifiers in source.
- Browser drawer explicitly selects intended v2; retaining v1 selection was a fixture expectation problem, not a production defect. Root corrected it by the real version button, preserving UI selection behavior.

## Deliberately retained unmapped contracts

Keep formal user.begin/task.accept revision-credential test, distinct from conversation confirm. Keep all four decision snapshot matrix scenarios (cross-project exclusion; early constraint after ten rounds; pending post-draft exclusion; curated exact list) and explicit empty decisions list overriding chat plus later empty-task inheritance. C's simple positive initial constraint does not replace those. Keep other conversation model/queue/recovery/unknown-usage/graph patch behaviors until their own authentic keeper review.

## Suggested targeted mutation for the restored gap

Under root's exclusive mutation test window, temporarily corrupt only restored proposal content in restoreDraft after removing archived_at, retaining correct version/pointer. B must fail at the immediate independently expected First version assertion, not at a later native tool failure. Restore bytes exactly and rerun candidate. A cheaper equivalent owner mutation that suppresses restoration should already fail the version guard but does not specifically verify the missing content preservation assertion. Reviewer performed no mutation.

## Documentation reconciliation

conversation-drafts.md still says prepared/not executed and no repository edits/no executed evidence. Root now reports applied keeper and passing33b. Update the durable ledger to final execution/review/carry result before claiming cutover completion; leaving the old preliminary warning as the sole evidence would contradict actual status. This is reporting consistency, not an extra production/test requirement.
