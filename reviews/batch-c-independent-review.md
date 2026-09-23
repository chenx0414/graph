# 批 C 独立评审

Verdict: fail

范围：`bf89d14..c3c8f73`（集成分支 HEAD）。四项程序检查均已核对通过：

- check-types `a2474bb10d1b87b61cb5493332b6e2be75ab0cbbe8526c2f89c29c771030fdb3` code 0
- check-naming-rules `39d3555794b403c564498b819b6a419aaf7059bc5ac8664232419e40af7fd82b` 10 passed
- check-conversation-ux `2932957e62d62d01449c713b49bae2b0f33d3f3591b535a1eb7e82c7f39239e4` 16 passed
- check-recipe-rules `94aca6133d58dc1ed65dac7f197ce1e64c963d7289a0c635a17a9a68c7321581` 7 passed

diff 只出现在三车道 `input.files` 列出的路径（17 个文件）。`package.json` 未改，没有新增 npm 依赖，没有改 IPC / Electron / Pi SDK / 服务端配置格式。

## 缺陷

### 1. 任务图看板没有常驻四项图例，任务页图例仍是旧五档且与新着色矛盾

验收 `graph-board-four-states` 要求「图区常驻四项图例」，四态为待执行 / 运行中 / 已完成 / 被阻塞。

四项图例只渲染在 `ConversationGraphBoard`（`src/web/Conversation.tsx` 约 392–400 行，`data-testid="graph-board-legend"`）。该组件只被右侧抽屉的草稿图页签使用（约 1266–1284 行）。抽屉默认 `data-open=false`，关闭时宽度为 0、`opacity: 0`、`pointer-events: none`（`src/web/styles.css` 1490–1503 行），所以默认状态下图例不可见。

真正带运行时节点状态的任务图页 `src/web/App.tsx` 约 921–927 行仍渲染旧五档图例：

- 待执行 / 就绪
- 执行中
- 已完成
- 失败
- 被阻塞 / 已跳过

该页复用了已改过的 `GraphCanvas`（`src/web/App.tsx` 933 行）。`GraphCanvas` 现在按 `boardNodeState` 给节点卡上色（`src/web/GraphCanvas.tsx` 60–74 行，样式在 `src/web/conversation-drawer.css` 84–87 行）。映射在 `src/web/insights.ts` 200–211 行：

- `ready` → 运行中（蓝），但任务页图例把「就绪」写在待执行（灰）
- `skipped` → 已完成（绿），但任务页图例把「已跳过」写在被阻塞（橙）
- `failed` → 被阻塞（橙），但任务页图例单独把「失败」写成红

使用者打开任务图看板时，节点颜色与旁边图例对不上，四项图例也不在该图区。`App.tsx` 不在本批文件清单，车道二无法改它；但共享的 `GraphCanvas` 已经把新着色应用到这个视图，却没有把四项图例一起带上。检查节点只跑了纯逻辑测试，没有覆盖这个页面，所以绿灯不能抵消这个缺口。

### 2. 未知状态没有在节点上明确标注

`boardStateLabel` 对未知状态返回 `待执行（未知）`（`src/web/insights.ts` 233–236 行），但节点卡只把它放在图标的 `title` / `aria-label`（`src/web/GraphCanvas.tsx` 67–74 行）。可见图标仍是待执行的 `○`，图例只在 `unknownCount > 0` 时追加「含未知 N」（`Conversation.tsx` 398 行），且该图例不在任务页。

运行中图会遇到未收录状态。`src/core/revision.ts` 127 行把被替换节点写成 `retired`；`src/core/time-ledger.ts` 13 行把 `retired` 当终态。`BOARD_STATE_BY_STATUS` 没有 `retired`，于是它落入待执行，节点上没有「未知」字样。`paused` / `queued` / `chatting` 等同理。验收要求未知状态归入待执行并明确标注；目前标注不可见。

## 已核对成立的部分

命名（`src/core/branch-naming.ts`、`src/git/integration.ts` 227–264 行）实际样例：

- 摘要「修复登录问题」、taskId `0faf1367-…` → 分支 `graph/task/xiu-fu-deng-lu-wen-ti-0faf1367`
- 工作副本分支 `graph/copy/xiu-fu-deng-lu-wen-ti-0faf1367/<nodeId>`
- 目录 `state/worktrees/xiu-fu-deng-lu-wen-ti-0faf1367/{integration,<nodeId>[-n]}`

前缀保留；短 id 保证同摘要不冲突；slug 最长 40、无空格及 `~^:?*[\`、无 `..`。未收录汉字保留原字符（`龘` → `龘-龘`）。`prepareTask` 只在尚无 `integration_branch` 时生成新名（`integration.ts` 365 行）；已有行只更新 sha，不改写 branch/path。全仓库没有反向解析分支名。拼音表是静态字面量（`src/core/pinyin-table.ts`），无网络、无新依赖。

抽屉：`defaultDrawerOpen()` 返回 false，组件默认参数使用它（`Conversation.tsx` 565 行）。主区保留 `proposal-draft`、`draft-graph`、`draft-acceptance`、`accept-branch`、`confirm-draft`，以及 `conversation-questions-${task.id}`（约 1052–1081、1118 行）。确认与目标分支只在草稿可确认且已绑定项目时出现，这是原有条件，不是被藏进抽屉。抽屉页签来自 `DRAWER_DRAFT_PAGES`，内含 `draft-page-tabs`、`drawer-draft-toc`、`conversation-graph`、`graph-state-summary`、`draft-graph-detail`。`tests/m8/app-shell-ux.test.ts` 是改定位后仍断言摘要、任务图、节点卡文本、任务状态概述，不是删断言。

配方：`saveAgentCombination` 保存成功后一律 `compileAgentCombination`，不再判断 `mode === 'main'`（`src/catalog/catalog.ts` 123–130 行）。编译失败返回 `compileError` 且不调用 `ensureDefinition`，界面 toast `配方已保存，但编译失败：…`（`ResourceLibrary.tsx` 792 行）。无效引用在 `capability-library.ts` 写盘前抛出，不产生配方也不产生定义。`ResourceLibrary.tsx` 已无「编译」按钮和 `/compile` 调用；`/api/catalog/combinations/:id/compile` 仍在 `src/server/app.ts` 736 行。`updateAgentCombinationDescription` 仍先更新再编译。`tests/m5/ui.test.ts` 改为保存后断言 toast 含「已编译为 review@1」，并断言没有编译按钮。

`nodeTone` / `NODE_TONE_COLOR` 五档语义未改；节点卡仍输出 `data-status`、`data-tone` 和含节点 id 的 `info.label`。

## 未由本评审执行的现场项

`human-batch-c` 要求使用者在真实控制台看 git branch / worktree list。代码路径支持该结果，但本评审没有跑真实 git，不能代替人工验收。
