# 批 C 独立评审（返工后）

Verdict: pass

范围：集成分支 HEAD `9202881`，对照基线 `bf89d14`。只读核对代码、diff 与程序检查证据，未看实现转录，未改业务文件。

程序检查（本轮证据，均为 code 0）：

- check-types `a2474bb10d1b87b61cb5493332b6e2be75ab0cbbe8526c2f89c29c771030fdb3`
- check-naming-rules `5dee8c35d43e4bd099621514fe96617d003c9dcd280e0ff522575173996f37da`（10 passed）
- check-conversation-ux `4bb4fcc7d062bc3ab60cf5bde04148d2704b7e25e40fda5e77e1d329994fb15a`（18 passed）
- check-recipe-rules `bc35186d7a52f711a2ab60ecd8c93cfb01fe2376d0ced8e31bf86006f9915b77`（7 passed）

上一轮失败的两条（图例不常驻、未知状态不可见）已在 `faeef61` 修掉，见下文四态节。`reviews/batch-c-independent-review.md` 是上一轮评审产物（`66d7faa`），不是本批实现文件，不计入车道越界。

实现 diff（`bf89d14..HEAD`，不含该评审文件）只出现在三车道 `input.files`：

- 车道一：`src/core/branch-naming.ts`、`src/core/pinyin-table.ts`、`src/git/integration.ts`、`tests/m3/branch-naming.test.ts`
- 车道二：`src/web/Conversation.tsx`、`src/web/GraphCanvas.tsx`、`src/web/insights.ts`、`src/web/styles.css`、`src/web/App.tsx`、`src/web/conversation-drawer.ts`、`src/web/conversation-drawer.css`、`tests/m8/conversation-drawer.test.ts`、`tests/m8/graph-board-state.test.ts`、`tests/m8/app-shell-ux.test.ts`
- 车道三：`src/catalog/catalog.ts`、`src/web/ResourceLibrary.tsx`、`tests/console/capability-library.test.ts`、`tests/m5/ui.test.ts`、`tests/m8/recipe-compile.test.ts`

`package.json` 未改。没有新增 npm 依赖，没有改 IPC / Electron / Pi SDK / 服务端配置格式与密钥处理。`tests/m8/conversation-ui.test.ts` 未改，不是删断言。

## ① 可读分支名

成立。`src/git/integration.ts` 不再用裸 uuid 模板：

- `prepareTask`：`taskBranchName(task.request, taskId)` 与 `taskWorktreeDirName(...)`（约 227–228 行）
- `workspace()`：`workCopyBranchName(...)`，实例目录在占用时追加 `-2`、`-3`（约 254–261 行）

用当前表实际算出的样例（`taskId` 前缀 `0faf1367`）：

- 摘要「修复登录问题」→ slug `xiu-fu-deng-lu-wen-ti`
- 集成分支 `graph/task/xiu-fu-deng-lu-wen-ti-0faf1367`
- 工作副本分支 `graph/copy/xiu-fu-deng-lu-wen-ti-0faf1367/impl-naming`
- 工作副本目录 `state/worktrees/xiu-fu-deng-lu-wen-ti-0faf1367/{integration,impl-naming}`

同一摘要配不同 taskId 短 id 不同，不会撞名。空串 / 全标点回落 `task`；超长截到 40 且去掉尾部 `-`；未收录汉字保留原字（「龘龘」→ `龘-龘`）。拼音表是 `src/core/pinyin-table.ts` 静态字面量，无网络、无 `pinyin-pro`。

历史任务：全仓库只有 `prepareTask` 一处写 `tasks.integration_branch`（`src/git/integration.ts:232`），且只在本次准备时写入。`workspace()` 若该实例已有 `worktrees.path` 直接返回，不重写。没有任何代码按新规则反向解析或迁移已记录的 branch/path。

分支名非法字符：slug 路径会折叠空格、`~^:?*[\]` 与 `..`。`nodeId` 仍原样拼进 `graph/copy/.../<nodeId>`，提案校验只要求非空（`src/core/proposal.ts:19`），这与改前 `graph/copy/${taskId}/${nodeId}` 相同，不是本批回退。实际节点 id 是 `impl-naming` 这类标识。

## ② 抽屉

成立，且策略模块被组件使用，不是摆设。

- `src/web/conversation-drawer.ts`：`defaultDrawerOpen()` 返回 false；`residentPanelIds()` 含 `proposal-draft`、`draft-graph`、`draft-acceptance`、`accept-branch`、`confirm-draft`、`conversation-questions`；`drawerPanelIds()` 含草稿版本 / 验收项 / 节点 / 决策 / 任务图。
- `Conversation.tsx` 从该模块导入并使用：`drawerOpen = defaultDrawerOpen()`（约 545 行）、`residentPanelIds().join`、`drawerPanelIds().join`、`DRAWER_DRAFT_PAGES.map`。
- 调用方 `App.tsx:136` `useState(false)`，经 `drawerOpen={detailOpen}` 传入。收起时抽屉 `width: 0`、`opacity: 0`、`pointer-events: none`（`styles.css` 约 1490–1503 行），且 `inert={!drawerOpen}`，草稿详情与任务图概述不常驻主区。
- 主区卡片仍固定渲染上述入口（约 1029–1065 行）。待处理问题 `conversation-questions-${task.id}` 与 `master-questions` 仍在主列，不进抽屉。
- 展开后页签保留 `draft-page-tabs`、`drawer-draft-toc`、`conversation-graph`、`graph-state-summary`、`draft-graph-detail`、`conversation-node-detail`。

## ③ 四态

成立，上一轮两条缺陷已修。

`src/web/insights.ts` `boardNodeState`：

- 待执行：`pending`、`draft`（以及未知）
- 运行中：`preparing`、`running`、`ready`
- 已完成：`succeeded`、`completed`、`skipped`
- 被阻塞：`blocked`、`failed`

节点运行时实际写入的状态是 pending / preparing / running / ready / succeeded / failed / blocked / skipped / retired。前八个都有确定映射；`retired` 不在表内，归入待执行。`nodeTone` 的五档（含 skipped→blocked、failed→error）未改，其它视图仍用它。

节点卡（`GraphCanvas.tsx` 约 65–81 行）保留 `data-status` / `data-tone`，新增 `data-board-state` 与状态图标。可读文本仍是 `graphNodeLabel`（节点 id + 名称）。未知状态另渲染可见文本「未知」且 `data-unknown="true"`，不再只藏在 `title` / `aria-label`。

四项图例由 `GraphCanvas` 自己渲染（约 219–227 行），`data-testid="legend"`，每项 `data-board-state`，含 label、图标、颜色与数量；未知数量注明「含未知 N」。任务页 `App.tsx` 只剩 `<GraphCanvas>`，旧五档文案「待执行 / 就绪」「被阻塞 / 已跳过」已删除。`Conversation.tsx` 不再自绘第二份 `graph-board-legend`。因此任务页和抽屉里的任务图都常驻同一份四态图例，不再与着色矛盾。

## ④ 配方保存后自动编译

成立。

- `Catalog.saveAgentCombination`（`src/catalog/catalog.ts` 约 123–130 行）保存成功后一律 `compileAgentCombination`，不再判断 `mode === 'main'`，成功时返回 `{ combination, definition }`。
- 编译失败不回滚已保存配方，返回 `compileError` 且不调用 `ensureDefinition`，因此不产生新定义。界面 `ResourceLibrary.tsx` 约 792 行用 danger toast 显示 `配方已保存，但编译失败：…`。
- 成功 toast 含 `已编译为 ${definitionVersion}`。源码中不再有「编译」按钮、`void compile(` 或对 `/compile` 的调用。
- `POST /api/catalog/combinations/:id/compile` 仍在 `src/server/app.ts:736`。
- `updateAgentCombinationDescription` 仍是先改描述再编译并返回 `{ combination, definition }`；描述自动保存走独立端点，失败仍显示「自动保存失败」，没有被保存路径吞掉。
- 无效引用在 `capability-library.saveAgentCombination` 写文件前抛出，不会落盘也不会编译。

## 测试强度

被改的既有测试是贴合新流程，不是删断言换绿：

- `tests/m5/ui.test.ts` 去掉点击「编译」，改为断言按钮数为 0，再走编辑保存，仍断言 toast 含「已编译为 review@1」。
- `tests/console/capability-library.test.ts` 增加保存即得 `worker@1` 且无 `compileError`，原有二次 compile 断言保留。
- `tests/m8/app-shell-ux.test.ts` 保留草稿摘要、打开任务图、节点卡文本（`human check`）、任务状态概述；补了主区入口可见、抽屉内四态图例、`data-status` / `data-tone` / `data-board-state`，并新增任务页图例断言（四项、无旧五档）。聊天输入在抽屉打开时仍可写。
- check 节点用的三个测试文件无 playwright / jsdom / 监听端口 / 子进程 / 真实 git。`recipe-compile.test.ts` 的 HTTP 检查用 `app.inject`。

## 未纳入本评审失败项

`human-batch-c` 仍需使用者在真实控制台确认四项观感（分支名、抽屉默认收起、四态辨识、无编译按钮）。那是后续人工验收，不是本独立评审的程序缺陷。
