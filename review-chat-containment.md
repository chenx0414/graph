# 批 C 收尾（聊天窗口收纳）独立评审

verdict: fail

评审对象：59639b416b2619d4b11d60d13d1c7fa41fd2c0f3

本轮评审对象是工作副本 HEAD `59639b416b2619d4b11d60d13d1c7fa41fd2c0f3`（`graph:review:9052a5a4-7455-4622-b38d-79f9c484ebdd`），不是上一份报告所写的 `0afe0d5`。工作区干净（`git status --porcelain` 为空）。实现提交 `ee1f4386bd320c07b2b33fdad88c67ea828cc9e0` 是 HEAD 的祖先；`git diff --stat ee1f438 HEAD -- src tests` 为空，产品与测试树与实现提交一致，HEAD 相对实现提交只多了上一份评审文件。复核命令：`git rev-parse HEAD`、`git status --porcelain`、`git show HEAD:src/web/Conversation.tsx`、`git show HEAD:src/web/conversation-drawer.ts`、`git diff --stat ee1f438 HEAD -- src tests`。

本轮按闸门返工第 2 轮重新取证，不沿用上一份报告的结论。上一份报告把评审对象写成旧提交 `0afe0d5`，并据此声称空态卡/绑定卡仍在聊天流、策略模块未声明初始化面板。那两条在当前集成里不作为本轮缺陷：当前任务说明第 0 条已把空态与绑定项目收进抽屉、并由 `conversation-drawer.ts` 声明（`DRAWER_INIT_PANEL_IDS = task-empty, bind-project`）标为已完成且不要重做。本轮只核对该轮点名的真缺陷与验收缺口。

## 结论

抽屉 section 状态机没有按返工要求修好。点「任务导航」后，复位逻辑仍写在组件 effect 里，且在「有提案、抽屉打开、任务模式、尚未选中任务」时会把 section 改回草稿页。任务导航条目因此不会渲染。纯函数 `resolveDrawerSection` 不存在，沙箱测试也没有覆盖返工要求的四条语义。聊天窗口收纳的其余已交付部分（草稿卡与任务卡移出聊天流、待答问题独立渲染、抽屉默认收起、带版本/状态/任务数的入口）在源码上成立，批 C 三项未被本 diff 削弱，但任务导航点不开使 drawer-holds-draft-and-tasks 不成立。

## 缺陷

### 1. 点「任务导航」会被复位 effect 打回草稿页（产品缺陷）

文件：`src/web/Conversation.tsx` 628–635（`git show HEAD:src/web/Conversation.tsx`）

```tsx
useEffect(() => {
  if (!view || !drawerOpen) return;
  if (drawerSection === 'task' && (!selectedTaskId || !view.tasks.some(task => task.id === selectedTaskId))) {
    const next = view.tasks[0]?.id ?? null;
    if (next) setSelectedTaskId(next);
    else if (view.proposal) setDrawerSection('draft');
  }
}, [view, drawerOpen, drawerSection, selectedTaskId]);
```

任务导航按钮（约 1240–1243 行）只做：

```tsx
onClick={() => { setDrawerSection('task'); if (!selectedTaskId && tasks[0]) setSelectedTaskId(tasks[0].id); }}
```

任务列表只在 `drawerOpen && drawerSection === 'task'` 时渲染（约 1319 行），`conversation-task-${task.id}` 在该分支内（约 1328 行）。

竞态：确认草稿后 `selectedTaskId` 仍为 `null`，`view.tasks` 也还是空（任务要等刷新才出现），用户点 `drawer-mode-tasks`。effect 看到 `drawerSection === 'task'`、`selectedTaskId` 为空、`view.tasks` 为空、且 `view.proposal` 存在，走到 `else if (view.proposal) setDrawerSection('draft')`。抽屉 `data-page` 回到 `acceptance`，`[data-testid^="conversation-task-"]` 数量为 0。之后任务到了也不会再切回 task，因为 effect 只在 `drawerSection === 'task'` 时动作。这正是 `tests/m8/integration.test.ts` 195–196 行「点 drawer-mode-tasks 后等待恰好 1 个 conversation-task-*」会超时的路径。

要求的语义是：用户的选择优先；只有所选任务已不存在、或根本没有任务时才回落到 draft；有任务时绝不因为有提案而强制回 draft。当前 effect 在「有任务但尚未写入 selectedTaskId」的同一轮渲染里就会因为提案把用户选择抹掉，而且判定没有抽到策略模块。

影响：任务导航点不开。抽屉不是「全部任务列表 + 选中任务执行详情」的可用去处；集成用例等待任务卡会超时。

### 2. 复位规则没有抽成 conversation-drawer.ts 的纯函数，组件另写了一份判定

文件：`src/web/conversation-drawer.ts`（`git show HEAD`）

该文件导出的函数只有 `defaultDrawerOpen`、`defaultDrawerPage`、`drawerPanelIds`、`drawerEntryPanelIds`、`residentPanelIds`、`drawerPageIds`、`isResidentPanel`、`isDrawerPanel`、`panelPlacement`、`draftStatusLabel`、`drawerEntryLabel`、`drawerEntryAriaLabel`。没有 `resolveDrawerSection`，也没有任何「用户选择优先 / 任务消失才回 draft / 有任务未选则视为 task 并选第一个 / 任务为 0 且无提案的默认值」的纯函数。

`Conversation.tsx` 628–635 的 effect 自己写了判定，没有调用策略模块。这违反「effect 只调用该纯函数，不得再另写一份判定」，也违反「conversation-drawer.ts 是常驻与抽屉状态策略的唯一事实来源」。

影响：状态机无法在沙箱里单测，组件可以继续绕过策略。

### 3. 纯逻辑测试没有补返工要求的四条断言

文件：`tests/m8/conversation-drawer.test.ts`

该文件断言了抽屉默认收起、聊天常驻三项、草稿卡归属抽屉、入口文案含版本/状态/任务数，以及源码字符串包含若干 testid。它没有导入或调用 `resolveDrawerSection`，也没有这四条：

1. 点开任务导航后 mode 保持 task（即使存在提案）
2. 所选任务消失时回落到 draft
3. 有任务但未选任务时视为 task 并选中第一个
4. 任务为 0 且无提案时的默认值

`tests/m8/conversation-drawer.test.ts` 在清单内，沙箱可跑，却没有覆盖本轮真缺陷。`check-chat-containment` 因此只证明了面板集合与入口文案，不能证明任务导航点得开。

`tests/m8/integration.test.ts` 195–196 行仍等待恰好 1 个 `conversation-task-*`，断言没有被删，这一点符合「不得删断言换绿」。但该等待没有先确认抽屉 section 停在 task，而产品代码会把它打回 draft，所以断言在新结构下不成立。

## 已核对且本轮不作为缺陷

- 聊天流切片（`conversation-thread-inner` 到 `conversation-runway`）不再包含 `proposal-draft`、`conversation-task-`、`node-summary-list`、`accept-branch`、`confirm-draft`。待答问题在 `taskQuestions.length > 0` 时独立渲染为 `conversation-questions` / `conversation-questions-${task.id}`，内含 `QuestionReply`，不依赖任务卡。没有待答问题时该区块不渲染。
- 草稿页（版本 TOC、验收项、节点、决策、任务图、确认草稿 + 目标分支）与任务导航结构都写在 `detail-drawer` 内；`defaultDrawerOpen()` 返回 false；顶栏 `drawer-entry` / `drawer-entry-label` 使用 `drawerEntryLabel`，文案为「草稿 vN · 状态 · 任务 N」，抽屉收起时仍在顶栏，不是只有图标。
- 实现 diff 只含清单内 8 个路径（`styles.css` 未改；CSS 在 `conversation-drawer.css` 并由 `Conversation.tsx` 引入）。`tests/m8/ui-flow.test.ts` 与 `tests/m5/ui.test.ts` 相对实现父提交无 diff。无 `package.json` 变更，无 IPC/Electron/Pi SDK/密钥处理改动。
- 批 C 三项不在本 diff 内：`src/core/branch-naming.ts` 仍是拼音 slug + 短 id；`src/web/GraphCanvas.tsx` 仍有 `data-testid="legend"` 与可见「未知」标注；`src/web/ResourceLibrary.tsx` 保存后走编译结果且无独立「编译」按钮。`check-batch-c-intact` 与 `check-types` 退出码均为 0。

## 程序检查

- `check-types`：exit 0。
- `check-chat-containment`：`tests/m8/conversation-drawer.test.ts` 20 tests passed。该检查没有覆盖本轮要求的 section 状态机。
- `check-batch-c-intact`：exit 0。
