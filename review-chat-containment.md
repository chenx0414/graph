# 批 C 收尾（聊天窗口收纳）独立评审

verdict: fail

评审对象：集成提交 `0afe0d5d23ffea12ac73580031c31c2e2b809771`（实现提交 `ee1f4386bd320c07b2b33fdad88c67ea828cc9e0`）。工作区干净，相对 HEAD 无未提交 diff。

## 结论

聊天窗口收纳没有完成。闸门返工第 1 轮要求移出的两块非对话卡仍无条件渲染在 `.conversation-thread-inner` 里，且没有经过 `src/web/conversation-drawer.ts` 的常驻策略。因此「聊天窗口只渲染对话消息、待答问题与输入区」和「策略模块是唯一事实来源」都不成立。

## 缺陷

### 1. 空态卡与绑定项目卡仍在聊天流

文件：`src/web/Conversation.tsx` 1083–1102

`.conversation-thread-inner` 在转录与待答问题之后、跑道之前无条件渲染：

- `{!view.tasks.length && (<div className="thread-action-card" data-testid="no-conversation-tasks">…尚无功能任务…)}`
- `{!view.projectId && (<section className="thread-action-card binding-card" data-testid="bind-project">… bind-select / bind-submit …)}`

这两块都是非对话卡。抽屉收起时它们仍出现在聊天窗口，直接违反 chat-window-chat-only。抽屉任务区虽另有一行 `drawer-task-nav-empty`（约 1322 行），但那只是副本，没有把聊天流里的空态移走。绑定控件只存在于聊天流，抽屉里没有 `bind-project` / `bind-select` / `bind-submit`。

影响：未绑定、尚无任务的会话打开后，聊天窗口不是「只剩对话、待答问题与输入区」。

### 2. 常驻策略不是这两块的判定来源

文件：`src/web/conversation-drawer.ts`

- `CHAT_RESIDENT_PANEL_IDS` 只有 `conversation-messages`、`conversation-questions`、`conversation-composer`。
- `DRAWER_PANEL_IDS` / `DRAWER_ENTRY_PANEL_IDS` 没有 `task-empty`、`no-conversation-tasks`、`bind-project` 或任何初始化面板。
- `drawerEntryLabel` 只拼接草稿版本/状态与任务数量，未绑定项目时不会显示「未绑定项目」。`Conversation.tsx` 944 行的「未绑定项目」是头部元信息，不是抽屉入口文案。

`Conversation.tsx` 1083–1102 没有调用 `panelPlacement` / `isDrawerPanel` / `residentPanelIds`，是无条件 JSX。组件绕过了规定的唯一事实来源。

影响：返工要求 B 未落地。已声明面板的「主区或抽屉」二分无法覆盖这两块；未声明块进入了聊天流。

### 3. 纯逻辑测试与 UI 测试都没有按返工要求改

文件：

- `tests/m8/conversation-drawer.test.ts`：没有断言 `task-empty` / `bind-project` 属于抽屉初始化面板，也没有断言未声明块不得进入聊天流，更没有断言入口文案含「未绑定项目」。现有 thread 切片测试只排除 `proposal-draft`、`conversation-task-`、`node-summary-list`、`accept-branch`、`confirm-draft`，漏掉了仍在 thread 切片里的两块。
- `tests/m8/conversation-ui.test.ts` 206、209、210：仍直接 `page.getByTestId('no-conversation-tasks'|'bind-select'|'bind-submit')`，没有先打开抽屉再定位。

影响：沙箱检查 `check-chat-containment` 通过（14 tests）不能证明收纳成立；它测的是不完整的策略，而不是返工后的归属。

## 已核对且成立的部分（不抵消上述缺陷）

- 草稿卡 `proposal-draft`、确认草稿 `confirm-draft`、目标分支 `accept-branch`、任务卡 `conversation-task-*`、节点清单 `conversation-nodes-*`、目标分支/集成提交/费用，位于抽屉（`Conversation.tsx` 1251–1364），不在 `.conversation-thread-inner`。
- 待答问题在 `taskQuestions.length > 0` 时独立渲染于聊天流（1065–1081，`conversation-questions` / `conversation-questions-<taskId>`，使用 `QuestionReply`），不依赖任务卡；无待答问题时不渲染。
- 抽屉 `data-open={drawerOpen}`，`defaultDrawerOpen()` 返回 false；顶栏 `drawer-entry` 用 `drawerEntryLabel` 显示草稿版本、状态与任务数量，并带 `aria-expanded`。这只覆盖已绑定且策略已声明的部分。
- 批 C 三项未被本 diff 削弱：改动文件限于清单内 8 个路径（另有评审文件 `review-chat-containment.md`，非实现）；`tests/m8/ui-flow.test.ts`、`tests/m5/ui.test.ts`、`package.json` 相对 `1a21c9e..ee1f438` 无 diff。`GraphCanvas.tsx` 仍有 `data-testid="legend"` 与未知标注；`src/core/branch-naming.ts` 仍做拼音 slug；`src/web/ResourceLibrary.tsx` 仍在保存后处理 `compileError`，无单独编译按钮。对应检查 `check-batch-c-intact` 与 `check-types` 均为 code 0。

## 证据

- `src/web/Conversation.tsx:1083-1102`
- `src/web/conversation-drawer.ts:42-76, 136-149`
- `tests/m8/conversation-drawer.test.ts:114-128`
- `tests/m8/conversation-ui.test.ts:205-210`
- 检查：`check-types.json` code 0；`check-chat-containment.json` code 0（14 passed，未覆盖返工断言）；`check-batch-c-intact.json` code 0（28 passed）
