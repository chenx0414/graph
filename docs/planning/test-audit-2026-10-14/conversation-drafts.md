# Native draft lifecycle candidate 32 — prepared, not executed

Prepared `/tmp/graph-conversation-drafts32.test.ts`, intended destination `tests/e2e/conversation-drafts.test.ts`. No repository edits or Vitest runs. Parent must apply only after its current freeze ends. No original declaration is yet authorized for retirement by evidence from this unexecuted draft.

## What changed from the older temporary draft

The previous plan described four workflows but its 204-line harness implemented only two, used direct SDK proposal creation, and omitted several older explicit-version assertions. Candidate32 implements all four with one browser/server/native-provider fixture. Actual clean Git repositories on branches named main replace bare temp directories, so stale proposal guards cannot be masked by missing target branches. Each draft is emitted as `propose_graph` by the external provider, executed by the installed native main, and followed by an actual SDK tool-result request. Expected owner receipts are never fabricated. Management/confirmation uses actual authenticated HTTP and archive/restore additionally uses real browser buttons. Worker submission is an actual native `submit` to another controlled provider; no scripted ActionAdapter, owner mock or SQL row fabrication exists.

Native tool errors are asserted by their independently authored user-visible guard message. Unlike validate_proposal, withdraw_draft throws RuntimeError and Pi normally exposes its message, so the older draft's expectation that vendor tool text always includes a structured error code was unjustified. Public HTTP failures still assert both status400 and exact error code.

Native model response plans are appended to the fixture-owned external server queue immediately before each explicit user turn. This only controls external vendor responses; the real owner creates all messages, revisions, statuses, acceptance, queues and invocation history. Every pause/resume is public HTTP, with native owner completion observed before pausing. Recipes use the ordinary public catalog runtime administrative service, as existing genuine native fixtures do.

## Four concrete workflow owners

A. `reviewed draft credentials survive in-place edits and explicit versions without confirming unseen content`:
- Native v1/rev1 real digest; native edit same v1/rev2 changes digest; replaced credential refused.
- Native explicit v2 preserves immutable by-version v1; exact active history accepted/stale flags, public unknown version not_found.
- Browser shows actual latest summary; latest-only confirm accepts actual known revision; receipt replay exact; new-request repeat refused; hidden anchor omitted from normal tasks; no worker input or requests.
- Native graph revision preserves check operation/edge, empty real queue, idle worker, relatedTasks origin:v2, old versions stale after requirement advancement, exact acceptance revision and frozen confirmed copy.
- Separate real conversation explicitly confirms the edited v1/rev2 after refusal of v1/rev1. This distinction was missing in the earlier sketch: proceeding directly to v2 could otherwise lose sole positive same-version revision-credential proof.

B. `archive, restore, deletion and withdrawal keep independent cards and monotonic version identities`:
- Native v1/v2, real browser archives v2, HTTP archives v1; active proposal/list empty, both archived versions visible through real HTTP and main SDK graphState; formal task view current proposal null; archived confirmation refused.
- Browser restores v1 while v2 stays archived, native default edit remains v1/rev2. Explicit new version allocates v3 rather than reusing archived v2.
- Delete v3 by HTTP; public by-version not_found and restore not_found; default next creation v4 proves deleted version reservation without relying on explicit newVersion.
- Native withdraw missing version gives intended message; native withdraw current v4 yields actual withdrawnVersion4/next5 receipt and actual user notice; old historical card remains; stale confirmation and repeated withdraw refused; next native draft v6 skips both reserved identities.

C. `deleting a confirmed source card preserves the real worker session, acceptance, graph and conversation context`:
- Initial actual user constraint recorded by main, native draft, real confirmation; public main status prompt contains task identity/work:idle and keeps requirementVersion2.
- Real worker receives direct job through public main SDK graphSend, submits via its own native vendor. Exact worker prompt contains frozen user constraint/header and excludes main monitoring header, with distinct real provider evidence.
- Actual post-work main vendor prompt now contains work:succeeded, requirement remains2. Wait for host operation terminal settled/failed before snapshots; no assertion claims the underlying operation passed unless verified.
- Require genuine worker entries/session and nonempty acceptance; deleting source card leaves exact session/entries/acceptance/graph revision/messages, task identity/acceptedProposalVersion/list unchanged, and source by-version read not_found. Snapshot comparisons protect preservation of independently produced real evidence; they do not compute expected new receipts from the subject.

D. `rebinding and another feature preserve confirmed scope while draft cards stay owned by their conversation`:
- Two real conversations produce native independent cards; archiving the other changes neither first proposal nor its archive list.
- Public bind A→B returns invalidatedDrafts true, increments requirement2, marks old card stale and refuses old confirm; native new B draft confirms actual task project B.
- While first task running, real user scope-change turn plus native later draft/confirmation yields distinct task queued, original running/acceptance remains unchanged, monotonic requirement4.
- Rebind B→A and native fourth version preserve old second/third source summary and first task's frozen native graph and original project B. Worker requests remain zero throughout, independently proving confirmation alone never dispatches work.

## Exact old declaration mapping (current names; lines may move)

| Old tests/m8/conversation.test.ts declaration | Candidate owner | Required before retirement |
| --- | --- | --- |
| explicit newVersion keeps draft history and only the latest can be confirmed | A | All exact history/stale/relatedTasks/queue/normal-list carries included; run and compare. |
| editing a draft in place replaces its content without stacking versions | A | Public by-version read for edited v1 is included after v2; run. |
| a confirmation credential from replaced draft content is refused | A | Separate same-v1/rev2 positive confirmation included; run. |
| archive hides a draft from the active list and restore brings it back | B | Public/main/formal visibility and native/browser restore carried; run. |
| deleting a draft hides it but never removes the graph it started | C | Genuine worker entries/session/acceptance + immutable graph/messages carried; run. |
| a confirmed draft is never overwritten by a later task or a rebinding | D (A also frozen copy) | D proves later source versions across bind and frozen native task; run. |
| a deleted or archived version is never handed out again | B | Archived v2, explicit v3/history[1,3], deletion and default next v4/history[1,4], archived[2]; run. |
| a deleted draft version is never handed out again | B | Default post-delete allocation v4, not just newVersion=true; exact active history[1,4]/archive[2] excludes deleted v3. Run. |
| restoring an archived draft makes it current again without stacking versions | B | Browser restore v1/default edit v1rev2/archived v2/new v3; run. |
| post-confirmation chat keeps the requirement fixed and sees real execution status | C | Native main request contains exact idle then succeeded, requirement2 both; run. |
| a scope change after confirmation becomes a new queued task, not an edit of the running one | D | Exact running/queued IDs and frozen acceptance descriptions; run. |
| rebinding a conversation invalidates drafts investigated for the previous project | D | Real branch/Git-valid target makes stale error intended; run. |
| a confirmed task carries the conversation decisions and constraints to its workers | C | Genuine native worker first request contains header + exact initial constraint; run. |
| the conversation status stays with the master while the constraints still reach the workers | C | Positive worker constraint plus negative main-status header; run. |
| the master can withdraw its own unconfirmed draft without losing it | B | Genuine native result missing/current/repeated guard, independent system notice and monotonic6; run. |
| draft cards belong to their own conversation and never leak across | D | Separate real conversation/native producer and archive scope; run. |

## Explicit remaining gaps and nonclaims

- **No executed evidence yet**: do not delete any mapped old test just because this temporary file exists. Typecheck, root-focused Vitest, runtime/browser outcome review still required.
- `accepting a draft needs the credential of the revision that was reviewed` uses formal user.begin/task.accept, distinct from conversation confirm. Keep until real formal-task start/accept public workflow owns it; not mapped here.
- `decision snapshots are frozen with the draft and scoped to the project binding` contains four independent cases (head retention beyond ten rounds; post-draft pending exclusion; curated verbatim; project rebind) and `an explicit empty decisions list revokes constraints without falling back to chat` has exact empty override and later-task inheritance. C's one initial constraint does not replace these. Retain all until a dedicated real multi-worker matrix exists.
- Native withdraw absent/repeated result field may be formatted by Pi SDK. Candidate uses actual returned message rather than assuming JSON error serialization; verify against runtime result before changing assertions. Successful withdraw expects the owner's actual JSON receipt as agent-tools currently emits.
- C's check module may fail for genuine Git/check prerequisites. It deliberately waits terminal and asserts original contract (acceptance facts survive deletion), not a fabricated pass. If an unrelated module failure prevents the intended worker or provenance path, diagnose owner/fixture rather than weakening to empty arrays.
- All application sources/test/support/executable routing stay frozen while parent's tests run. /tmp candidate imports intentionally target eventual tests/e2e location; do not execute directly from /tmp or claim import resolution validation.

## Proposed root application order

1. End active checkout freeze. Copy prepared file into tests/e2e, review fixture cleanup and authentic tool result schema.
2. Run typecheck and focused new owner+old conversation sibling on stable checkout. Watch real native tool outcomes and terminal check before interpreting any failure.
3. Fix only demonstrated fixture or owner bugs; record failing controls for production bugs. Preserve original tests until all mapped contracts pass.
4. Independent preservation review, then exact old declaration retirement. Do not remove mixed whole-file routing or existing genuine e2e.

Read-only syntax check: `node --check /tmp/graph-conversation-drafts32.test.ts` passes (host Node26.3). This does not resolve imports, typecheck, or execute test bodies; project-pinned runtime/full typecheck remain root work.

## Applied cutover 33/34 (supersedes prepared-state notes above)

Root已将候选应用为 tests/e2e/conversation-drafts.test.ts。A/C/D首轮通过；B首轮误把用户仍选中的v1当应自动切到v2，按产品保留选择契约改为真实点击drawer-draft-version-2，不修改生产。随后6文件39项全通过25.22秒。独立逐16声明保留复核仅发现restore后应在编辑前保护原摘要；已补原First version、active[1]/archive[2]并通过。

故意仅在restoreDraft恢复动作改写spec.summary为RESTORE_CORRUPTION，实际public+browser keeper在期望First version得到RESTORE_CORRUPTION处红。第一试mutation用了错误SQLite字符串写法，只得到restore未完成，不计保留性证明；修正SQL单引号后明确命中内容guard。源码逐字节恢复SHA256 d3252562d59d346717c83bace3daac29a3224fa389faa2a80881f85a421543fc，/tmp/graph-test-audit-control33-restore-valid-case.log。恢复后4文件61项全部通过28.91秒（/tmp/graph-test-audit-preserved33.log），随后精确退休上表16旧声明，独立formalaccept与decisions矩阵保持。

同批context-model前2parser声明共7旧context/predecessor/dependsOn/when/container拒绝输入移至真实graphCreate整图原子拒绝keeper，拒绝后实际native图照常运行完成。故意允许context字段，该keeper在应拒绝反而成功创建graph处红；interface-spec逐字节恢复SHAebe9a26d58e911c913aaad727d265af92643e3629634a3dc540c93884d350800。context其余12原生工作流完整保留，整文件审计后纳e2e routing。不声称本批已完成全量/覆盖率目标。
