# Conversation startup/archive retirement preservation review 32

Read-only independent review, 2026-10-15. No source/test/routing edits and no Vitest runs. This report reviews the current checkout, not an asserted future migration. Root reports batch30 passed; this reviewer did not independently rerun it during the frozen Vitest window.

Read: CODING_STANDARDS.md, CONTEXT.md, test-audit SKILL/CAMPAIGN/reference, ADR0009/0002, /tmp/graph-conversation-full-cutover-plan.md, all 695 lines tests/e2e/composer-lifecycle.test.ts (including fixture, restore binding exception, all browser/provider cases), exact four original declarations in tests/m8/conversation.test.ts, real conversation create/list/archive/unarchive owner and task list view in task-runtime.ts, dispatch readiness/archive guards in execution.ts, HTTP route forwarding and host autoDrive lifecycle. History for the old suite includes conversation/draft evolution; public archive metadata remains an active API contract.

## Verdict

Two declarations can retire now after the reported stable keeper pass: initial pending recovery and archive admission. Two need small precise assertion carries into the existing real keeper before retirement: projectless startup and archive/restore API metadata. No new test file, mock, fixture-written receipt, source seam or routing exclusion is needed.

All four share the genuine keeper `queued messages survive a real restart and receipt replay without merging FIFO turns or dispatching an archived conversation` at tests/e2e/composer-lifecycle.test.ts:566. This is real HTTP + real browser + native main model/provider transport + closed and freshly opened persistent owner. The synthetic vendor supplies external responses only. The keeper's initialDrive:false is a real host execution mode, not a fake queue. Its restart method closes the producer and opens a new server/runtime on the original state directory; the optional SQL binding exchange belongs to another test and is NOT used here.

## 1. a conversation starts and chats without a project or feature task (current old line84): C, carry precise postconditions before delete

Already retained: omitted project; public view projectId null; sole original first user message has stable receipt identity, exact text and pending state; view tasks=[]; public /api/tasks=[]; zero vendor requests before drive. Fresh server recovers native master; actual first answer eventually exists; later view projectId null/tasks=[]; final three independent operations and delivered users prove one operation per FIFO turn. Dedicated main prompt keeper at lifecycle:650 also asserts exact stable user ID + text + requirement version transport anchors.

Still not explicitly retained in this keeper: post-first-answer master.status='succeeded', requirementVersion=1, and public /api/tasks=[] AFTER discussion dispatch. Send mode is not an exact substitute for succeeded (failed/blocked states may also be inactive). Pending /api/tasks=[] does not alone assert the post-dispatch hidden-anchor list rule. Also add exact first provider prompt anchor for `firstMessageId`, v1 and `FIFO first message` if retiring every old context assertion rather than relying on shared prompt keeper.

Suggested minimal carry at the existing first send-mode wait: capture afterFirst=f.view(id); expect afterFirst to contain master:{status:'succeeded'}, requirementVersion:1, projectId:null,tasks:[]; exact first user delivered / first assistant done and text; /api/tasks=[]; actual first vendor user prompt contains the known message anchor. This preserves old observable fields without asserting internal host dispatch call shape.

Credible lost regressions otherwise: settlement accidentally marks master failed despite writing an answer; discussion changes requirementVersion; API starts exposing completed chatting anchors while pre-dispatch anchors remain hidden. Existing later send-mode/UI/provider-count checks need not catch all three.

## 2. conversations can be archived and restored without deleting their history (current old line209): C, carry API receipt metadata before delete

Already retained: archived view true; default list empty, archived list contains the sole exact conversation ID; exact original user text history survives producer restart/archive; unarchive default list returns exact ID and archived list becomes empty; actual queued work resumes and original first answer remains in exact final assistant history. This is stronger durable history and browser/native evidence than the original one-message mocked-master fixture.

Missing independent API response contract: archive receipt `{archived:true, conversationId:id}` and persisted archived list `.archivedAt` matching that receipt; unarchive receipt `{archived:false,archivedAt:null}`. Current f.post checks only HTTP success and both receipt bodies are discarded. A wrong returned archived flag or timestamp can pass every current keeper assertion. task-runtime.ts:1067-1090 currently deliberately returns these fields and app.ts forwards them as public API, so classify as retained public API, not obsolete implementation detail.

Suggested carry: save archive receipt from the existing archive POST, assert exact id/true; require finite positive archivedAt to make the equality non-vacuous; archived list [0] archivedAt equals that receipt. Save unarchive receipt, assert false/null, optionally public view false/null. No fabricated metadata or sleeps needed.

Original initial unarchived membership is implied by final active-list owner proof but an extra first list `[id]` is cheap if exact state transition coverage is desired.

## 3. an archived conversation does not occupy a chatting lane (current old line230): C, safe to retire now

The earlier paused+archived ambiguity is resolved: keeper explicitly POSTs resume while still archived, observes paused=false, calls actual runtime.host.runReady() and requires dispatched:0, plus unchanged actual provider request count1. Then public unarchive and provider's independently held second beforeReply prove dispatch actually proceeds when the archive restriction is removed; exact second native request contains queued second text and excludes third. Third later runs separately. No fake operation or direct state-row seeding is involved.

The negative is supported by a positive continuation using the same real queued input and restored producer. Resume removal of pause is explicitly verified. Owner's laneTasks SQL, readyNodesFor guard and execute guard all honor archived_at; keeper need not target a particular one of these redundant protections, since boundary contract is no dispatch while archived. Old seen.length1 is replaced by actual wire observations and exact answer sequence. No uncovered independent contract found.

## 4. queued messages survive a restart and are answered once (current old line898): C, safe to retire now

The previously missing initial-pending path is now explicit. First owner autoDrive=false creates exact first pending message through authenticated public HTTP, persists it, makes zero provider requests, then is closed. Restart creates fresh server/runtime with autoDrive=true; real native request yields first answer. This is not merely restarting a paused queued state. Same fixture later covers additional queued messages across another restart. Final assistant contents are exact three answers, users delivered with three distinct operation IDs, vendor request count exactly3, and reload still exactly3. These catch unsent message loss, initial replay, duplicate turn consumption and merged turns. Repeated host.runReady invocation itself is an internal test mechanism; actual continuously running owner + final observed exact wire counts preserves its user-facing once-only contract.

Do not conflate this with the separate `restart resumes only a proven unsent Pi conversation (%s)` stage table: that table's before_session/session_opened/model_sent recovery and uncertainty classification are NOT covered by this keeper and remain independent migration work.

## Root validation before retirement

After unfreeze, carry the two groups above into existing lifecycle keeper, run its focused suite and sibling old conversation suite on a stable checkout. Remove only exact four declarations after carry passes, then rerun owner proof and typecheck/diff checks. Do not classify the remaining old conversation file wholesale as e2e: many lower-layer ActionAdapter-driven declarations remain. None of this report claims overall campaign completion or <=2% coverage.

## Root carry, mutation and cutover

现有 FIFO/restart keeper已补首答后的真实 master succeeded/requirementVersion1、delivered/done、公开tasks[]、实际首wire message anchor、闲置runReady0；补真实archive回执id/true/正有限数字timestamp、重启后archived列表同timestamp、unarchive false/null。首轮错误夹具假定timestamp字符串，实际源采用Date.now数字；改为正有限数并保持精确持久相等，不修改产品。

4旧声明在对应候选通过后退休。故意仅将archive returned timestamp设0，真实public keeper在positive timestamp guard红（非其他状态失败）；task-runtime逐字节恢复SHA256 d3252562d59d346717c83bace3daac29a3224fa389faa2a80881f85a421543fc。恢复跨owner12文件95项绿33.81秒，退休后11文件80项绿34.80秒。剩余混合conversation旧文件仍在lower runner，未whole排除。
