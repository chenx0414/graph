# Browser test inventory — read-only lane 33

All ten assigned test files read completely, including helper setup and every declaration. No source/test/routing edits or Vitest execution. SHA256 snapshots below identify exact reviewed bytes. Only the three whole-file genuine E2E entries are eligible for coverage exclusion. A browser filename or Chromium import does not qualify seeded/mocked business workflows.

## Boundary evidence

Read full src/server/host.ts (actual runtime and listening Fastify server; autoDrive pumps real host), workspace-tabs.ts, CLI/provider/evidence fixtures already inspected. Read relevant App state/loading/retained Activity/shortcut/routing entry points; Conversation fetch/send/pause/history owners; real app config/conversation/message/attachment/draft handlers; Settings load/autosave/vendor credential/probe owners; startGraphDaemon config/secret initialization and hot-apply entry references. Catalog/scanner/resource owners were fully read in resource lane. Inspected last history commits for the three candidate files. Config and conversation entry handlers forward to actual owners; external vendor fixtures are permitted external boundary controls.

The startGraphDaemon settings workflow uses real disk config, real effective secret resolution and browser autosave. Its page.route race delays/fetches the actual startup response and continues the actual config request; it does not fabricate those DTOs. Browser clock only advances UI timers. One declaration uses public supervisor/project/confirm methods then actual HTTP config rejection; this is a real complete service workflow despite no browser in that specific declaration.

shell-tabs uses real public runtime creation and browser routing; one node URL is a UI tab destination, not claimed executed node receipt. DOM data-retained marker is an observation of retained DOM identity, not fabricated business state. conversation-ui uses real native model runtime and real vendor HTTP stream; test provider emits propose_graph at the external model boundary, after which real production owners build/confirm/persist the graph. Telemetry first declaration reads the real public runtime projection produced by that call.

## Per-file and per-declaration ledger

### tests/m8/app-shell-ux.test.ts

SHA256 `a293301447237a46854ea410c5e87f6d7699928220edc54b812d23831edc7a6b`. mixed_or_requires_migration; 32 declarations.

1. **R — whole/individual genuine E2E** — `a draft window refreshes in place and the only archived card remains manageable` (line 66): real browser and public runtime/domain operations, real disk/catalog/Git/HTTP as applicable.
2. **R — whole/individual genuine E2E** — `the shell groups conversations by project and keeps an unbound recent section` (line 168): real browser and public runtime/domain operations, real disk/catalog/Git/HTTP as applicable.
3. **R — whole/individual genuine E2E** — `conversations archive from the sidebar and restore from settings` (line 227): real browser and public runtime/domain operations, real disk/catalog/Git/HTTP as applicable.
4. **R — whole/individual genuine E2E** — `the right drawer keeps proposal details and node inspection independent from the chat` (line 266): real browser and public runtime/domain operations, real disk/catalog/Git/HTTP as applicable.
5. **R contract / migrate producer before exclusion** — `a graph agent node opens the same chat transcript used by the main agent` (line 436): appendNodeEntry writes synthetic user/briefing/tool/result/final records without real worker.
6. **R — whole/individual genuine E2E** — `the task graph page keeps the permanent four-state legend` (line 547): real browser and public runtime/domain operations, real disk/catalog/Git/HTTP as applicable.
7. **R — whole/individual genuine E2E** — `conversation pause and resume use one stateful action with visible feedback` (line 585): real browser and public runtime/domain operations, real disk/catalog/Git/HTTP as applicable.
8. **R — whole/individual genuine E2E** — `the right drawer toggle stays available and opens an empty state` (line 618): real browser and public runtime/domain operations, real disk/catalog/Git/HTTP as applicable.
9. **R contract / migrate producer before exclusion** — `the composer suggestion and queue steering follow the three Enter states` (line 652): custom master action prepare/interrupt supplies asserted suggestions, completion and steering.
10. **R contract / migrate producer before exclusion** — `Escape closes the model menu before it interrupts the running Agent` (line 753): custom master action supplies interrupt callback/outcome.
11. **R contract / migrate producer before exclusion** — `the project picker adds a local project to the sidebar` (line 804): window.graph fabricated directory picker and secret/relaunch bridge.
12. **R contract / migrate producer before exclusion** — `agent markdown renders and tool activity appears before the final answer` (line 848): fulfilled conversation DTO fabricates Markdown messages and telemetry.
13. **R contract / migrate producer before exclusion** — `live tool activity groups and streamed markdown follow the transcript tail` (line 924): fulfilled conversation DTO and synthetic Graph event stream.
14. **R contract / migrate producer before exclusion** — `a coarse streamed delta is revealed progressively instead of landing as one block` (line 1035): fulfilled snapshot and synthetic Graph delta instead of real vendor/native stream.
15. **R contract / migrate producer before exclusion** — `interrupted retry streams are removed before the durable final answer` (line 1124): fulfilled snapshot and synthetic interruption/final event sequence.
16. **R contract / migrate producer before exclusion** — `the composer model control switches model and thinking as one persisted selection` (line 1195): fulfilled settings/conversation/model responses; request capture only, no persisted selection owner.
17. **R contract / migrate producer before exclusion** — `the resource library groups reusable assets and includes graph architectures` (line 1278): real filesystem catalog but openResource asserted against fabricated desktop bridge.
18. **R — whole/individual genuine E2E** — `the recipe editor searches and sorts Skills, MCP and Pi extensions by name, enabled state and recipe usage` (line 1382): real browser and public runtime/domain operations, real disk/catalog/Git/HTTP as applicable.
19. **R — whole/individual genuine E2E** — `the Main Agent recipe is visible with fixed system capabilities and an editable capability recipe` (line 1504): real browser and public runtime/domain operations, real disk/catalog/Git/HTTP as applicable.
20. **R contract / migrate producer before exclusion** — `the inbox keeps resolved questions in history` (line 1554): fulfilled inbox history DTO.
21. **R — whole/individual genuine E2E** — `the composer inserts project file mentions and carries text attachments into the message ledger` (line 1587): real browser and public runtime/domain operations, real disk/catalog/Git/HTTP as applicable.
22. **R contract / migrate producer before exclusion** — `the composer slash menu selects tools, switches model and queues compaction` (line 1634): fulfilled settings/model/compact/messages responses; no real owner consequences.
23. **R — whole/individual genuine E2E** — `the new-chat slash menu stays inside the viewport and inserts an inline tool token` (line 1718): real browser and public runtime/domain operations, real disk/catalog/Git/HTTP as applicable.
24. **R — whole/individual genuine E2E** — `the new-chat composer supports project mentions and attachments before submitting` (line 1747): real browser and public runtime/domain operations, real disk/catalog/Git/HTTP as applicable.
25. **R contract / migrate producer before exclusion** — `the new-chat composer switches model and thinking before the conversation starts` (line 1789): fulfilled settings and POST conversation response.
26. **R — whole/individual genuine E2E** — `settings opens as a second page with its own navigation and return control` (line 1847): real browser and public runtime/domain operations, real disk/catalog/Git/HTTP as applicable.
27. **R — whole/individual genuine E2E** — `the compact shell keeps the new-chat composer inside the viewport` (line 1887): real browser and public runtime/domain operations, real disk/catalog/Git/HTTP as applicable.
28. **R — whole/individual genuine E2E** — `the chat header exposes editable Agent prompts and Main Agent tools` (line 1909): real browser and public runtime/domain operations, real disk/catalog/Git/HTTP as applicable.
29. **R contract / migrate producer before exclusion** — `a self-improvement report renders as its own card in the conversation` (line 1988): appendMessage writes fabricated applied RSI/activation receipts.
30. **R contract / migrate producer before exclusion** — `the sent tab shows the tool declarations one request carried, with their count and size` (line 2049): fulfilled agent-context sent receipt/tool declarations.
31. **R contract / migrate producer before exclusion** — `draft markdown follows preferences and image attachments survive sending and reload` (line 2096): real image/message lifecycle plus fake usage-refresh owner/count assertions; declaration is mixed.
32. **R — whole/individual genuine E2E** — `live Markdown edits one source, reveals syntax at the caret and preserves undo and composition` (line 2135): real browser and public runtime/domain operations, real disk/catalog/Git/HTTP as applicable.

### tests/m8/conversation-boundaries-ui.test.ts

SHA256 `7f529891b50199a78cd0d5999a5d21ae4c357dcbe896121ce3ad9f5d57e96998`. mixed_or_requires_migration; 2 declarations.

1. **R contract / migrate producer before exclusion** — `the conversation page surfaces master questions, live worker status, costs and message history` (line 32): custom master action supplies replies and usage (graph worker portion real).
2. **R contract / migrate producer before exclusion** — `ask_user replaces the composer with Markdown choices and submits multiple answers` (line 152): SQL inserts both waiting questions; no actual ask_user producer.

### tests/m8/conversation-drawer.test.ts

SHA256 `20333c599344c5e0112b92c077af1dc47499e129a9468df79f98ab3fcd0f2691`. pure_lower_layer; 25 declarations.

1. **R contract / migrate producer before exclusion** — `the drawer is collapsed by default` (line 34): direct policy helper or source/CSS text assertions; no browser/runtime boundary.
2. **R contract / migrate producer before exclusion** — `the drawer body owns a stable vertical scrollbar` (line 37): direct policy helper or source/CSS text assertions; no browser/runtime boundary.
3. **R contract / migrate producer before exclusion** — `groups task artifacts in task order and keeps project artifacts separate` (line 47): direct policy helper or source/CSS text assertions; no browser/runtime boundary.
4. **R contract / migrate producer before exclusion** — `the chat stream keeps only the transcript, the questions and the composer` (line 69): direct policy helper or source/CSS text assertions; no browser/runtime boundary.
5. **R contract / migrate producer before exclusion** — `the draft card and the task overviews are not resident any more` (line 77): direct policy helper or source/CSS text assertions; no browser/runtime boundary.
6. **R contract / migrate producer before exclusion** — `draft versions, the two draft pages and the task navigation all live in the drawer` (line 92): direct policy helper or source/CSS text assertions; no browser/runtime boundary.
7. **R contract / migrate producer before exclusion** — `the empty task state and the project binding are drawer initialization panels` (line 103): direct policy helper or source/CSS text assertions; no browser/runtime boundary.
8. **R contract / migrate producer before exclusion** — `every declared panel is either main-resident or drawer, with no third home` (line 114): direct policy helper or source/CSS text assertions; no browser/runtime boundary.
9. **R contract / migrate producer before exclusion** — `main and drawer panels are disjoint and unknown ids have no placement` (line 126): direct policy helper or source/CSS text assertions; no browser/runtime boundary.
10. **R contract / migrate producer before exclusion** — `clicking the task navigation stays on task even when a proposal exists` (line 137): direct policy helper or source/CSS text assertions; no browser/runtime boundary.
11. **R contract / migrate producer before exclusion** — `a proposal never forces the still-loading task list back to the draft page` (line 141): direct policy helper or source/CSS text assertions; no browser/runtime boundary.
12. **R contract / migrate producer before exclusion** — `a disappeared selected task keeps the task navigation and adopts the next task` (line 146): direct policy helper or source/CSS text assertions; no browser/runtime boundary.
13. **R contract / migrate producer before exclusion** — `the task navigation stays reachable while it is still empty` (line 155): direct policy helper or source/CSS text assertions; no browser/runtime boundary.
14. **R contract / migrate producer before exclusion** — `with tasks but no selection, task is shown and the first task is selected` (line 168): direct policy helper or source/CSS text assertions; no browser/runtime boundary.
15. **R contract / migrate producer before exclusion** — `opening the task navigation with no tasks keeps it open` (line 173): direct policy helper or source/CSS text assertions; no browser/runtime boundary.
16. **R contract / migrate producer before exclusion** — `the draft page stays put and is never yanked away` (line 182): direct policy helper or source/CSS text assertions; no browser/runtime boundary.
17. **R contract / migrate producer before exclusion** — `carries the draft version, the draft status and the task count` (line 190): direct policy helper or source/CSS text assertions; no browser/runtime boundary.
18. **R contract / migrate producer before exclusion** — `also states that no project is bound, alongside the draft state and task count` (line 211): direct policy helper or source/CSS text assertions; no browser/runtime boundary.
19. **R contract / migrate producer before exclusion** — `Conversation.tsx wires the drawer policy instead of hardcoding it` (line 222): direct policy helper or source/CSS text assertions; no browser/runtime boundary.
20. **R contract / migrate producer before exclusion** — `the drawer renders the draft pages plus the task graph, keeping their testids` (line 238): direct policy helper or source/CSS text assertions; no browser/runtime boundary.
21. **R contract / migrate producer before exclusion** — `the draft card, the confirm controls and the task cards moved into the drawer` (line 255): direct policy helper or source/CSS text assertions; no browser/runtime boundary.
22. **R contract / migrate producer before exclusion** — `the empty task state and the project binding live in the drawer, keeping their testids` (line 264): direct policy helper or source/CSS text assertions; no browser/runtime boundary.
23. **R contract / migrate producer before exclusion** — `the chat thread itself no longer renders the draft card or the task cards` (line 272): direct policy helper or source/CSS text assertions; no browser/runtime boundary.
24. **R contract / migrate producer before exclusion** — `finished work is tucked away, a decision or a running task stays in the list` (line 292): direct policy helper or source/CSS text assertions; no browser/runtime boundary.
25. **R contract / migrate producer before exclusion** — `a shared artifact belongs to the project group, not to the task that produced it` (line 306): direct policy helper or source/CSS text assertions; no browser/runtime boundary.

### tests/m8/conversation-history-ui.test.ts

SHA256 `279377602c5c9ec054865fa21a4f4767e14fde57679fd4e17c4019cd3091dc8e`. mixed_or_requires_migration; 5 declarations.

1. **R — whole/individual genuine E2E** — `history pages to the earliest record, survives new messages, and never crosses conversations` (line 72): public conversation create/chat owners produce durable messages; real browser history/SSE transport.
2. **R — whole/individual genuine E2E** — `a burst larger than one page fills the middle records without duplicates` (line 143): public conversation create/chat owners produce durable messages; real browser history/SSE transport.
3. **R contract / migrate producer before exclusion** — `processed history messages update from pending to delivered without a reload` (line 174): custom master action supplies consumed/completed outcome; replace with real native provider.
4. **R — whole/individual genuine E2E** — `interleaved conversations page by their own records, not by global sequence steps` (line 214): public conversation create/chat owners produce durable messages; real browser history/SSE transport.
5. **R contract / migrate producer before exclusion** — `reopening a live conversation attaches its snapshot without replaying old bubbles` (line 265): SQL inserts master/operation state plus internal persistConversationActivity/publishConversationDelta and old event flood.

### tests/m8/conversation-ui.test.ts

SHA256 `5ad7836a868f1c2a2eb211e9dc0a5216b95c7f8df2a95d346abbfd6289402ff4`. genuine_e2e; 2 declarations.

1. **R — whole/individual genuine E2E** — `conversation telemetry comes from recorded master usage and the configured context window` (line 148): real ModelRuntime/native master with external HTTP provider; real runtime/browser/Git/persistence/restart.
2. **R — whole/individual genuine E2E** — `a first-time user chats, drafts, confirms, keeps talking, and recovers after restart` (line 177): real ModelRuntime/native master with external HTTP provider; real runtime/browser/Git/persistence/restart.

### tests/m8/drawer-artifacts-ui.test.ts

SHA256 `81a1fef1b67d9cada8844edcd18f3a53e662ffdcfc32fb19b8ac004e06043e79`. mixed_or_requires_migration; 1 declarations.

1. **R contract / migrate producer before exclusion** — `the shared-artifact index shows a task's artifacts apart from the project's own, and a detail opens in its own tab` (line 25): constructs low-level ArtifactWorkspace with invented node/instance/operation/activation producer receipts; browser rendering genuine but publication producer bypassed.

### tests/m8/graph-board-state.test.ts

SHA256 `ff92897d2972fd9eba1fa2b000b179295191a639af4fa84585ecd433facba313`. pure_lower_layer; 11 declarations.

1. **R contract / migrate producer before exclusion** — `every existing status maps to its documented state` (line 32): direct state mapping/legend helpers or source text assertions; no browser/runtime producer.
2. **R contract / migrate producer before exclusion** — `unknown statuses fall into 待执行 and are explicitly marked 未知` (line 39): direct state mapping/legend helpers or source text assertions; no browser/runtime producer.
3. **R contract / migrate producer before exclusion** — `known labels do not carry the unknown marker` (line 49): direct state mapping/legend helpers or source text assertions; no browser/runtime producer.
4. **R contract / migrate producer before exclusion** — `four states have distinct colours and icons and the expected labels` (line 55): direct state mapping/legend helpers or source text assertions; no browser/runtime producer.
5. **R contract / migrate producer before exclusion** — `always returns the four legend states in order, even with no nodes` (line 66): direct state mapping/legend helpers or source text assertions; no browser/runtime producer.
6. **R contract / migrate producer before exclusion** — `counts each node, folding unknown statuses into pending` (line 71): direct state mapping/legend helpers or source text assertions; no browser/runtime producer.
7. **R contract / migrate producer before exclusion** — `the legend keeps the state colour and icon for the four items` (line 79): direct state mapping/legend helpers or source text assertions; no browser/runtime producer.
8. **R contract / migrate producer before exclusion** — `node cards carry data-board-state and a state icon without dropping the readable label` (line 91): direct state mapping/legend helpers or source text assertions; no browser/runtime producer.
9. **R contract / migrate producer before exclusion** — `an unrecognised status gets a visible data-unknown badge on the card` (line 103): direct state mapping/legend helpers or source text assertions; no browser/runtime producer.
10. **R contract / migrate producer before exclusion** — `GraphCanvas itself renders the permanent four-item legend, so every task-graph view has it` (line 110): direct state mapping/legend helpers or source text assertions; no browser/runtime producer.
11. **R contract / migrate producer before exclusion** — `the conversation drawer keeps the task-graph testids without a second legend` (line 123): direct state mapping/legend helpers or source text assertions; no browser/runtime producer.

### tests/m8/settings-ui.test.ts

SHA256 `b52f9a1e4b0884053edbd918cbfb545f14a5f80e34a566cd6bb557bf7d2cf41b`. genuine_e2e; 10 declarations.

1. **R — whole/individual genuine E2E** — `settings auto-save models, credentials and limits without leaking secrets` (line 105): real daemon config file/HTTP/browser/vendor endpoint; no fake business DTOs.
2. **R — whole/individual genuine E2E** — `configured vendor panel edits an account and removes its linked models` (line 371): real daemon config file/HTTP/browser/vendor endpoint; no fake business DTOs.
3. **R — whole/individual genuine E2E** — `settings fills new and existing model prices from the local cc-switch snapshot` (line 396): real daemon config file/HTTP/browser/vendor endpoint; no fake business DTOs.
4. **R — whole/individual genuine E2E** — `chat composer toggles full access with one click and settings no longer hosts the control` (line 448): real daemon config file/HTTP/browser/vendor endpoint; no fake business DTOs.
5. **R — whole/individual genuine E2E** — `removing a model bound to an unfinished task is refused and the daemon keeps the binding` (line 493): real daemon config file/HTTP/browser/vendor endpoint; no fake business DTOs.
6. **R — whole/individual genuine E2E** — `settings imports detected subscription credentials without exposing their values` (line 534): real daemon config file/HTTP/browser/vendor endpoint; no fake business DTOs.
7. **R — whole/individual genuine E2E** — `switching the account in step one follows through to the model list in step two` (line 565): real daemon config file/HTTP/browser/vendor endpoint; no fake business DTOs.
8. **R — whole/individual genuine E2E** — `an account whose own key has no value is not reported as resolved` (line 606): real daemon config file/HTTP/browser/vendor endpoint; no fake business DTOs.
9. **R — whole/individual genuine E2E** — `the vendor card keeps its fields readable instead of crowding them` (line 634): real daemon config file/HTTP/browser/vendor endpoint; no fake business DTOs.
10. **R — whole/individual genuine E2E** — `a supported platform offers an editable account name` (line 689): real daemon config file/HTTP/browser/vendor endpoint; no fake business DTOs.

### tests/m8/shell-tabs-ui.test.ts

SHA256 `e97c4d27b7b252f613e8d54d2bd51cbec38452cb436adcc72253abc91ee75caa`. genuine_e2e; 5 declarations.

1. **R — whole/individual genuine E2E** — `the shell opens one tab per destination, keeps the second visit on the first tab, and closes onto the neighbour` (line 49): real browser navigation/retention/keyboard/DOM with actual public runtime-created state.
2. **R — whole/individual genuine E2E** — `one task can be open in several tabs: its graph and one of its nodes are separate tabs` (line 94): real browser navigation/retention/keyboard/DOM with actual public runtime-created state.
3. **R — whole/individual genuine E2E** — `the drawer toggle sits in the workspace bar on every window, and outside a conversation the drawer is only a launcher` (line 120): real browser navigation/retention/keyboard/DOM with actual public runtime-created state.
4. **R — whole/individual genuine E2E** — `switching into a conversation does not replay a page entrance animation or duplicate context loading` (line 167): real browser navigation/retention/keyboard/DOM with actual public runtime-created state.
5. **R — whole/individual genuine E2E** — `workspace shortcuts retain conversation DOM and drafts, open context in a tab, and close the last tab` (line 179): real browser navigation/retention/keyboard/DOM with actual public runtime-created state.

### tests/m8/skill-slash-ui.test.ts

SHA256 `0689916adf85cc4352f21fb41b1ebc26328eb5ff4e848ae84b42d7bf78b415fa`. pure_lower_layer; 1 declarations.

1. **R contract / migrate producer before exclusion** — `the slash menu offers bound skills and inserts a /skill token` (line 26): fulfilled settings and agent-context capability DTO plus fabricated message POST response.

## Cutover limits

Do not route app-shell-ux, conversation-history-ui, conversation-boundaries-ui, drawer-artifacts-ui, skill-slash-ui, graph-board-state or conversation-drawer whole-file. Preserve their existing genuine browser flows while migrating the artificial portions. Individual genuine cases in mixed files may be moved unchanged to a dedicated genuine E2E keeper, with shared helper extraction serialized through root; re-read the final resulting whole file before exclusion. No moves are authorized or performed by this report.

Graph-board and drawer helper/source tests need behavior mapping to existing real graph/browser keepers before retirement, with independent contracts such as unknown-state presentation, stable scrollbar, task lifecycle grouping and orphan artifact ordering assessed separately. Source wiring/helper identity assertions do not require freezing implementation. Do not assume new resource or skills keepers cover unrelated browser contracts just because feature names overlap.

Artifact drawer fixture has real stored artifact bytes but uses invented provenance, so real list/render assertions do not prove runtime publication correctness. Replace producer with a real native worker publish flow (existing artifact-publication keeper may absorb it), retain 135-version pagination and promotion/tab/grouping UI contracts. Live history last declaration requires real held vendor stream plus genuine host snapshot/reattach, not SQL insertion or internal delta calls.

## Validation status

This inventory is source classification only. Root must compare SHA before applying executable inventory edits, coordinate the frozen checkout, and run candidate whole-file/sibling proof. No claim of a new passing test run or completed migration.
