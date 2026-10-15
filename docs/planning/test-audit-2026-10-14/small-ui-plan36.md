# Small UI / desktop coherent-layer audit 36 (read-only)

Scope: tests/app/{desktop,insights,setup}.test.ts; tests/console/{message-time,tool-stats,tool-activity,thinking-levels,settings-sections,workspace-tabs,price-snapshot}.test.ts. All 10 candidate files read in full, including tables: 1,008 test LOC, 80 declarations. No repository edits or Vitest executions in this lane. This is a cutover plan, not permission to route mixed files as E2E.

Read CODING_STANDARDS, CONTEXT, test-audit SKILL/CAMPAIGN and ADR 0030. Relevant history includes 3c6113b (turn-boundary elapsed), 751bf38 (same-port reload), ec09456 (archived price snapshot), b5e78cb (account thinking levels), 0a9d75b (settings simplification), 6826699 (tabs). None is evidence that the protected contract was withdrawn.

Owners fully read: desktop/lib.ts, web/labels.ts, insights.ts, tool-activity.ts, workspace-tabs.ts, TabBar.tsx, transcript-model.ts, runtime/thinking.ts, catalog/thinking.ts, price-snapshot.ts, web/thinking-levels.ts, ToolStats.tsx. Entry points/callers traced: desktop/main.mjs launch/IPC/poll/reload paths; App.tsx tabs and title/close callbacks; TranscriptRows.tsx clock/footer/tool labels; GraphCanvas.tsx tone; Settings.tsx navigation and obsolete advanced registry; store.ts tool recording/SQL aggregation/retention/clear; runtime producer + spool and HTTP routes; start.ts default price-verification and refresh transaction. Large component files were inspected at those relevant owner paths, not certified wholesale for unrelated contracts.

Keepers fully read for this plan: e2e/thinking, e2e/provider-metadata, e2e/desktop-shell, e2e/insights-ui, e2e/pricing, e2e/secret-lifecycle, m8/shell-tabs-ui. Composer/composer-lifecycle and m8/settings-ui relevant declaration bodies were inspected; no claim that their whole inventory is newly certified by this report. Current routing is executable tests/e2e-routing.ts, reading graph/runtime inventories, plus tests/e2e glob; default includes every tests/**/*.test.ts. Candidate lower-layer paths must stay lower until retirement or actual whole-file conversion.

## Priority 1: thinking owner layer (10 declarations)

Primary keeper: tests/e2e/thinking.test.ts `catalog thinking options survive config saves and clamp actual conversation requests`. This actually saves config through POST, reads /api/settings and /api/config, creates conversations, waits for durable invocations, checks telemetry, and independently checks actual main vendor requests' reasoning_effort. Model cases are literal independent expectations. Stronger than pure helpers and proves process forwarding too.

1. C model exact catalog strengths: grok + deepseek keeper cases exact levels.
2. C OpenCode Go saved account vocabularies: account + bunny cases through config save/read and actual wire.
3. C original provider labels/no off: keeper checks every option `{level,label:level}` and grok vocabulary excluding off.
4. C toggle-only model Pi defaults: toggle case exact minimal/low/medium/high and default medium on wire.
5. C unknown model fallback: unknown case exact options and stale xhigh->high wire.
6. C reasoning:false still thinking on/off clamp: legacy case actual off->low wire.
7. C unsupported requested effort: grok max->xhigh, minimal case->low, deepseek medium->high; off also legacy.
8. C stale saved default doesn't expand vocabulary: account xhigh->max, unknown xhigh->high, exact exported options.
9. C level-map null internals: observable denied offered vocabulary + actual selected wire covers the public contract; null map encoding itself is implementation detail. Do not add map-shape E2E.
10. C default second strongest: grok default high, toggle default medium, bunny default xhigh, account stale max. Missing literal no-default deepseek case (current deepseek requests medium, also yields high, but doesn't prove default rule). Add one no-default deepseek case. Correction after independent SDK/source review and root candidate: single-level and empty-array inputs are BOTH reachable from actual catalog metadata. nano-gpt/openai/gpt-5-pro declares effort high only; new single case now proves exactly [high] and actual default high wire. llmgateway-providers/novita/ling-3.0-flash declares effort none only, alias maps to off, map forces off null and denies every other level, so SDK getSupportedThinkingLevels returns []. New empty case now proves actual API [], telemetry off, and actual wire has no reasoning_effort. This contradicts the overly broad production comment that options are never empty; do not change current product behavior in pruning. Only remaining carry is explicit no-request deepseek-default -> high (three-level vocabulary second strongest), which root is adding.

Unlocked seams: no dead production function; runtime/catalog thinking functions have real callers. Deleting only tests must not delete clamp/map/default functions. Most efficient cutover is extend existing genuine 9-row matrix and model-editor row, then delete the whole 118-line helper file, then focused thinking/provider metadata verification. Existing green history is insufficient after adding rows.

## Priority 2: obsolete settings layer (7 declarations)

Owner Settings.tsx 498-532: SETTINGS_SECTIONS is real navigation data used at 1069; AdvancedSetting interface, ADVANCED_SETTINGS=[], ADVANCED_SETTING_IDS, defaultAdvancedOpen, isAdvancedOpen are defined but have NO production callers (repo-wide rg; only old test imports). No advanced region actually exists. Remove obsolete advanced interface/constants/functions with the artificial tests. Keep sections as private in-module constant after removing sole external test consumer.

1. C exact settings sidebar labels/order `常规`, `归档对话`: missing as exact DOM inventory in current inspected keeper. Add to existing m8/settings-ui first browser scenario before navigating away, or e2e/sediment-settings real settings visit. Poll `.settings-nav-item` allTextContents to literal array; click archived and observe actual archived section, return general. This is a user navigation contract, not copied source inventory.
2. C no top-level 并发限制/settings-limits: literal exact sidebar labels above handles top-level absence, existing real provider-metadata account case checks no #settings-limits. Preserve positive visible inline controls first.
3. D ADVANCED empty registry shape: obsolete no-caller implementation inventory. User-facing lack of region is already in m8/settings-ui first case: no #settings-limits, visible provider-concurrency.
4. C inline credential controls keyed by selected credential: e2e/provider-metadata account case reads 3/old-group/8, edits to5/team/9, disk confirms, returns to edited account. m8/settings-ui first case reads/edits local controls and restart persistence. Literal DOM controls prove IDs through actual behavior. No separate ID-builder test needed.
5. D artificial SAMPLE starts collapsed: no production region/caller; test asserts its own constant's `defaultCollapsed`.
6. D defaultOpen(SAMPLE) all closed: obsolete API, no production caller.
7. D read explicit SAMPLE map: obsolete API, no production caller.

Whole-file retirement after one small real sidebar carry is coherent; ~93 test LOC plus ~35 obsolete source LOC. Never remove SettingsSection user navigation itself. No invented advanced row needed.

## Workspace tabs: 17 declarations

Primary keeper m8/shell-tabs-ui.test.ts; keep it at its real boundary. It builds real app, creates real conversations via owner, drives native Chromium, reads real tab DOM. Its startup summary is fixture config (not proof of model execution); that is fine for tab policy. Do not count impossible `impl-shell` page contents as real node behavior; it proves only destination identity.

Identity1 C same destination reused/different destination distinct: first keeper conversation+usage and keyboard context cover uniqueness; add explicit second real conversation to prove same-kind/different-id.
Identity2 C detail/graph canonical same tab vs node distinct: second keeper graph/node distinct/revisit graph, but lacks `/tasks/id` alias. Navigate same real graph through both aliases and assert exact one graph tab.
Identity3 C new chat/settings/setup not tabs: first keeper + last keyboard close cover `/`; second covers settings takeover; setup needs carry before full deletion.
Identity4 C route identity/title map: keeper covers conversations, graph, node, usage, catalog, context; missing inbox/tools/models routes and invalid route null. Add a compact real rail navigation table for actual supported pages; obsolete /nonsense returns-null policy has no tab UI producer and can D that row. Do not create real tasks merely to assert a copied route list.
Activation1 C new tab active: first/second keeper exact data-active.
Activation2 C revisit active no growth: first keeper tab-open-0 + usage revisit.
Activation3 C catalog subaddress updates existing tab's hash: missing. Visit catalog/skills then catalog/mcp via real in-app navigation; open another tab; reactivate catalog and assert location hash mcp, count one. This catches stale destination regression.
Activation4 D unknown activation no-op: App openWorkspaceTab first checks existing tabs and returns before activateTab; TabBar passes only live id. No public input reaches this API with arbitrary id; don't simulate a bogus DOM event to preserve helper implementation identity.
Activation5 C retitle one without changing active/others: withTitles is actually rendered; artifact retitle callback is actual producer. Current drawer-artifacts-ui references actual artifact title but not fully audited here. Carry real conversation rename + background active id invariant or actual artifact publication/detail keeper; do not assert a private retitle helper call.
Closing1 C active->right: first keeper closes first of two with usage right; positive exact active.
Closing2 C rightmost->left: missing. Open two real conversation tabs, close active rightmost, assert left active/hash/content.
Closing3 C background close keeps foreground: missing. Three real tabs, activate third, close first, assert third identity/hash unchanged.
Closing4 C only->empty: first keeper and keyboard last case positive new-chat UI.
Closing5 D unknown close no-op: TabBar emits only current id, no arbitrary public close endpoint; App's close receives current UI ids. No independent external contract.
Titles1 C conversation title/task request: first and second keeper literal title from real created conversation/task.
Titles2 R blank/missing title fallback until actual blanktitle source input shown. Current conversation creation text nonblank; generic placeholder during async loading is legitimate. Can carry held *genuine* /api/conversations response with transport gate, assert generic then release and assert real title. Do not fabricate list DTOs.
Final extra C preserve exact artifact project/version/draft query/context identity/home clears active: keyboard keeper covers context + home final; artifact project/digest versions and draft `?v` need existing artifact/draft E2E keepers read and exact tab reactivation query carry. Do not delete based on mere route rendering.

Expected coherent cutover: strengthen existing shell-tabs keeper with a three-conversation close/navigation matrix; preserve exact query addresses in their artifact/draft primary keepers. Retire helper whole file only after all C/R above resolved. workspace-tabs helpers all have real production callers except `activeTab` (only test? verify repo wide before remove) and `tabId` used App. Do not remove actual state policy merely to reduce coverage.

## Message time: 8 declarations, no current keeper for most exact contracts

All R->C proposed into one genuine transcript browser workflow, not discard. Existing composer lifecycle exercises timestamps incidentally but has no `message-time`/`message-elapsed` assertions. rg across tests finds no other explicit message footer keeper. Add one strongest boundary owner rather than four layers.

1 R wall clock today/yesterday/same year/prior year/missing. Produce actual message once, read its real saved timestamp independently, then advance browser's clock-only date across day/year boundaries and reload the real UI; compare literal expected text based on controlled observed instant. Browser timezone fixed. Do not rewrite message timestamps or route.fulfill fabricated transcript. Native runtime timestamps stay real; browser wall clock is the external presentation input. Missing timestamp should be source-checked against producer reachability before inventing an E2E row.
2 R seconds/minutes/hours formatting. Controlled full runtime timestamp boundaries need an external clock facility or genuine historical imported data; current harness lacks one. Do not make 1h sleeps or fake owner DTOs. Preserve test until supported public history flow or source-backed test-only impossible case rejection.
3 R earliest turn -> final elapsed. Genuine provider gate with real delay; inspect saved user/answer timestamps and browser elapsed text. Independently check range or literal controlled duration, not subject-generated label helper.
4 R one answer alone/live no elapsed. Live current composer raw stream can positive-guard actual streaming row then assert no elapsed. Alone occurs paged history; use genuine page limit/history boundary, not one forged message.
5 R live narration stamp from segment update. Need real SSE/live provider segment + `message-time` timestamp; existing copy/stream E2E has actual stream but no stamp. Carry there, positive guard raw row.
6 R subsecond no 0秒. Native short answer can still be >1s on load; deterministic timer/clock at full producer boundary needed. Avoid flaky duration expectation or presuming fast local response.
7 R receipt-like turn uses later user/previous answer. Name misleading: fixture is ordinary assistant text `回执`, NOT data.reloadReceipt; true reload receipts are deliberately filtered at transcript-model245. Protect later boundary generic semantics through actual two turns. Existing lifecycle has true turns but lacks elapsed assertions.
8 R no-user resumed turn starts previous answer. Requires actual RSI/continuation producer; existing rsi-shape workflow is the likely owner, must inspect/carry; cannot replace by two unrelated normal turns.

History 3c6113b is actual boundary regression. No blanket deletion of this file now.

## Tool activity: 1 declaration, 6 independent rows

R/C all rows into actual tool-producing transcript owner: bash `rg`, `ls`, `cat`, compound `ls; rm` retains executor/bash and run label; read SKILL.md -> Skill; actual MCP name -> MCP. `toolActivity` feeds TranscriptRows and transcript-model group summary/status; not dead. Composer actual read tool group proves copy absence only, not category label or compound-shell safety. Extend one real provider tool program (safe compound command use `ls; printf ...` instead of destructive rm) and inspect expanded activity labels and folded summary; skills read in existing agent-skills flow can absorb Skill label. Real MCP fixture owner must emit actual named call for MCP row. Until then retain sole unit, not D because short. No need duplicate labels across runtime/unit/browser after migrated.

## Tool statistics: 5 declarations, independent storage/upgrade contracts

All R for now; none of inspected current E2E uses tool-stats-row/table. Producer path is actual pi-adapter guarded recordToolCall or runtime/tool-call-spool ingestion; public GET /api/tool-stats, POST /api/tool-stats/clear, web ToolStats real table. Need one genuine tool-execution + restart + clear browser/HTTP workflow, plus one legacy-installation startup workflow.

1 R aggregation odd/even median, errors, total/max, count ordering, positive lastAt. New real producer must execute 4 successful/failing tool calls. Real measured ms assertions should compare to independently read produced records, not invent recordToolCall(...) rows; sorted math independent expected computation is acceptable. Exact mock 100/300/... time constants are implementation fixture only; preserve mathematical odd/even behavior.
2 R unknown instance attribution null. A destroyed node after genuine call retains recorded attribution; not same contract! Source unknown owner can be orphan spool at ingestion, so use genuine spool then external legacy/orphan state input if supported; don't insert raw stats or call private recorder to claim E2E.
3 R reopen +90day pruning. Genuine produced installation, close, external restored old installation/timestamp provenance fixture or full clock boundary required. Never forge tool execution receipt just to test retention. Preserve current until plan supplied.
4 C public clear once real calls exist, then assert removed count/empty stats/UI; native confirm accept, don't call private clear.
5 R schema v35 upgrade. This is genuine persisted-schema contract, cannot D for being direct SQLite. Existing old test creates newest then manually downgrades schema; stronger keeper can start a real daemon against a legitimate captured v35 database fixture and inspect tool stats/new actual producer after migration and user_version. No ad hoc removal of columns unrelated to this contract without explaining original schema. Keep until genuine startup migration replaces it.

No removal of recordToolCall/stats/clear/retention functions: real runtime/API callers exist.

## App insights: 2 declarations

1 R unknown vs zero token UI. e2e/composer-lifecycle actual unknown context null and zero recorded usage do not by themselves assert `formatTokens(undefined) -> 未知` vs exact zero. Carry actual unknown budget/usage public view and UI unknown token state, real zero user-visible usage, before retire. `ComposerTelemetry` context label has separate formatting and currently formatTokens applies limit only; don't pretend context null proves generic formatter unknown label.
2 R node statuses->5-tone palette. Current GraphCanvas emits data-tone from real node status. insights-ui inbox/100nodes only asserts existence/count; no preparing/succeeded/failed/blocked palette. Can carry in graph node-budget/node-submit/graph lifecycle real states and inspect `data-tone` after positive real status guard. Pure 5-tone helper remains production. `m8/graph-board-state.test.ts` source assertions do not prove native palette, and 4-state board palette differs. No removal until real state coverage.

## Config seeding: 2 declarations

1 C minimal first seed and never overwrite: desktop-shell second already reads actual seeded disk `{version:1,projects:[]}`. Missing nonoverwrite. Strengthen same fixture: after first real launch write a valid config with project/credential metadata as external user input, real relaunch and inspect same document + startup models/project; no Map filesystem mock. Can retire test after carry.
2 R write failure false/no throw: real unwritable path. macOS fixture use an actual read-only mounted volume (package preflight already owns hdiutil) or valid immutable filesystem input for isolated GRAPH_APP_USER_DATA config, ensure state remains writable and only config path unwritable. Need verify expected desktop fallback behavior, not merely assert helper result. Mode000 is unreliable root/operator permissions. Keep until real failure case.

## Desktop: 23 declarations, mixed broad owner, do not route/retire whole file

1 C dev paths: desktop-shell true launch already proves source root/current userData config/state via real files; add explicit startup state path if needed. Helpers' exact source/server path shape is implementation; only actual running source/assets matter.
2 R packaged paths: existing shell launches desktop/main.mjs dev, app.isPackaged=false. package-preflight intentionally fails before complete build. Neither proves packaged daemon+web. Need actual staged packaged bundle Electron launch, keep old now.
3 C source checkout override: desktop-shell app-root copied real source overrides stale env. Handles source redirect concrete behavior. Distinct env-only override still item19.
4 R resource allowlisted roots: main IPC validates kind first and opens OS shell. True Electron bridge openResource request could verify returned path + mkdir, but opens Finder (authorized test temp paths; avoid UI noise if possible). No fake shell helper call. Browser resource-library guidance not desktop folder launch.
5 C state/web/free port: real desktop startup realconsole metadata loopback variableport + real loaded built frontend covers functional launch. Exact CLI arg order is not user contract.
6 C execute+usable config: real desktop always mode execute,dynamic; no-config view path is old helper generic option not actual App launch. Need actual initial execute-intent can bind hot saved config (existing providers real config); config file launch seeded by real desktop. Don't copy argv table into E2E.
7 R loopback banner parse/rejection: real positive startup loopback is covered; hostile banner rejected by parser and navigation guard is security contract. Need real child external banner fixture at process boundary (replace fixture checkout CLI as external executable, not production parser) or nonloopback navigation denied in real Electron. These are distinct paths; navigation blocked doesn't prove parser rejects daemon-ready banner. Preserve original negative until direct child harness exists.
8 R keychain ciphertext roundtrip: desktop-shell explicitly `--use-mock-keychain` and says does not cover encryption. e2e/secret-lifecycle is daemon bridge only, no safeStorage persistence. Genuine Electron safeStorage IPC with actual encrypted bytes and restart required; no fake codec.
9 R unavailable encryption/corruptfile fallback: unavailable requires actual platform backend unavailability or supported Electron launch mode. Corruptfile can be actual seeded external secrets file then real App start. Do not forge codec outcome and call E2E.
10 R preserving undecryptable untouched entry: existing daemon secret keeper never reads desktop secrets.json. Seed encrypted entry made by real safeStorage plus unrelated malformed raw entry, update different ref via real IPC, inspect raw keys/unchanged bytes. Existing external file input is legitimate.
11 R explicit undecryptable revocation: same real IPC+disk scenario, ensure untouched entry survived first to positive guard then delete malformed entry.
12 R tail logs bounded dialogs: no strong keeper; actual failing child writes >=13 nonblanklines to stderr, real native dialog may need screenshot/OS UI. Inspect app path; don't remove merely cosmetic.
13 R tray image/menu open question count: existing shell root repo tray exists, no tray assertion; need actual Tray contextMenu native API (Electron app.evaluate can inspect public Menu/Tray but not module lexical var). Use real notification/poll graph states and OS tray automation if stable; must not mock Menu builder.
14 R first snapshot primes/new question/terminal notification transitions: actual platform Notification produced from pollTasks, no current keeper. OS notifications may be suppressed; inspect actual public Notification show events without replacing owner, or platform observer. Keep.
15 R answered/unchanged terminal suppresses repeated notification: same workflow with positive first notification guard then transition/time poll. Lack of visible OS toast alone inadequate.
16 R secret bridge validation/null/trim/no mutation: true daemon bridge keeper covers null revocation but not Electron `window.graph.saveSecret` entry validation/trim etc. Carry real preload bridge IPC table, observe actual secret-status/pending/disk and invalid ref rejected before write. Old object nonmutation is helper implementation, no standalone contract.
17 C durable app-root wins staleenv: desktop-shell shell() exact existing positive proof.
18 R invalid source root fallback env orbase: current shell has valid fileRoot and stale env. Add launch variants invalidfile +validenv, invalidboth =>devbase and actual loaded frontend. Don't assert resolver return only.
19 R env-only/blank/default: same launch table; blank/unset realprocess env source inputs, actualstartup source root check.
20 C appRootFilePath: existing real `.graph/app-root` producer/consumer exact path survives launch; internal join helper alone redundant.
21 R pending RSI reload only when idle/nonreentrant: real shell regular relaunch isn't automatic pollRsi/ack. Extend genuine RSI command produced request while held real provider operation, assert no restart then release and exactly one ownedreplacement + real ack. Malformed status helper inputs impossible through typed real daemon maybe D per-row after source evidence, not all negatives.
22 R same-port reload refresh document: latest historical bug 751bf38 real Electron loadURL sameurl fails. Current shell manual `page.goto(restarted.url)` bypasses desktop.showConsole and changes port; not keeper. Need actual automatic RSI replacement retaining port (daemon may persistent preferredport contract inspect) and document/session rebind proof. Keep until true path or explicitly unsupported sameport source evidence.
23 R restore only internal conv route across portchanges; reject settings?secret/arbitrary URL: real desktop route persistence/restart not currently asserted. Create real convo, navigate, close/reopen/relaunch actual App, verify internal hash +newport and no externalurl. Seed last-conversation-route file with untrusted URL as legitimate persisted external state, assert safe root. Don't call restore helper direct.

## Safe execution order for root

1. Settings sidebar exact labels, advanced heading absence and second-account three keyed controls were added and root reports passing candidate. Root is adding actual archive click/general return; after that remove no-caller advanced layer + its 7-test helper file and run candidate/control.
2. Thinking single-level and empty-vocabulary actual catalog/wire rows now carried and passing per root. Add no-default deepseek row; then retire 10-helper layer. Preserve real thinking functions.
3. Extend real shell-tabs matrix and query keeper paths; retire 17-helper layer only after all residuals resolved. App activeTab has sole test consumers; check current callers and remove dead export/function if true.
4. Build one real tool program that simultaneously proves tool labels, tool stats, error counting, restart, clear; upgrade/retention remain independent legacy fixture inputs, no invented receipt rows.
5. Desktop is its own large process/platform lane, not a small-helper deletion batch; preserve keychain/security/package/OS notification unique contracts explicitly until migrated.

All stated keeper coverage above is source inspection, not a new green execution claim. Root remains sole owner of Vitest windows and inventory writes. No lower-layer file can be hidden from <=2% coverage solely because the desired E2E is proposed here.
