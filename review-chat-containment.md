# 批 C 收尾（聊天窗口收纳）独立审查

审查对象：`ee1f4386bd320c07b2b33fdad88c67ea828cc9e0`（`graph:impl-chat-containment`），工作副本 `/Users/macmini/Library/Application Support/Graph/state/worktrees/pi-c-shou-尾-liao-tian-chuang-kou-shou-na-08f4591b/integration`。对照基线 `1a21c9e`。

裁决：fail。

## 结论

草稿卡、任务卡、节点清单、确认草稿与目标分支确实离开了聊天流，进了右侧抽屉；抽屉默认收起，顶栏入口带草稿版本/状态与任务数量。批 C 三项（可读命名、四态图例、配方自动编译）没有被这次 diff 碰到，对应检查通过。

但聊天窗口并没有收敛成「只保留对话消息、等待使用者确认的问题与输入区」。`.conversation-thread-inner` 在有任务、无待答问题时仍会常驻「尚无功能任务」卡；未绑定项目时仍会常驻「绑定项目」卡。这正是使用者要求移出聊天流的那类概览/操作卡，且程序检查没有覆盖它。

## 缺陷

### 1. 聊天流仍常驻非对话卡片（阻断 chat-window-chat-only / human-chat-containment）

文件：`src/web/Conversation.tsx` 1060–1102。

`.conversation-thread-inner` 在转录与跑道之间渲染：

- `taskQuestions.length > 0` 时的「等待你确认」（允许）。
- `!view.tasks.length` 时的 `thread-action-card[data-testid=no-conversation-tasks]`：「尚无功能任务 / 确认草稿后才会创建并开始执行。」
- `!view.projectId` 时的 `thread-action-card[data-testid=bind-project]`：绑定项目选择与提交。

验收与任务说明要求聊天窗口只留对话消息、待答问题与输入区；草稿/任务/图概览块全部移出聊天流。待答问题被明确写成「唯一允许留在聊天窗口的非对话块」。这两张卡既不是对话消息，也不是待答问题，也不是输入区。

影响：

- 没有功能任务的会话（确认草稿之前的常态）聊天流里仍然有一张任务概览卡。使用者抱怨的就是聊天流里堆卡片；空状态卡把同样的问题留在了最常见的路径上。
- 未绑定项目时，聊天流里还有一张操作卡。绑定控件不在抽屉，也不在输入区。
- `tests/m8/conversation-ui.test.ts:206` 仍断言 `no-conversation-tasks` 出现在页面上，说明这不是遗漏渲染，而是被当成仍应留在聊天页的内容。`conversation-drawer.test.ts` 只在 `conversation-thread-inner` 到 `conversation-runway` 的源码切片里排除 `proposal-draft` / `conversation-task-` / `node-summary-list` / `accept-branch` / `confirm-draft`，没有排除这两张卡，所以沙箱检查可以绿着通过。

主 Agent 问题区 `master-questions`（1036–1044）在聊天列、message-list 之外，有未答主 Agent 问题时可见且可用 `QuestionReply`。它属于「等待使用者确认的问题」，不单独构成失败；但它也不在策略模块的常驻集合里。

### 2. 常驻策略不是组件的唯一判定（次要，但不满足「不得绕过硬编码」）

文件：`src/web/conversation-drawer.ts`；`src/web/Conversation.tsx` 137–139、866–871、909–920、1064、1082、1090、1250。

`conversation-drawer.ts` 确实导出了聊天常驻集合、抽屉面板集合、`defaultDrawerOpen()` 和入口文案构造器，组件也调用了 `drawerEntryLabel`、`residentPanelIds`、`drawerPanelIds`、`DRAWER_DRAFT_PAGES`。但「什么留在聊天」的实际判定没有走这个模块：

- `residentFlag()` 只给 `conversation-messages` / `conversation-questions` / `conversation-composer` 打 `data-resident`。组件却把同一函数用在抽屉内的 `proposal-draft`、`draft-graph`、`accept-branch`、`confirm-draft` 上，结果恒为 `undefined`。标记没有约束渲染位置。
- 聊天流是否渲染空任务卡、绑定卡、问题区，由 `!view.tasks.length`、`!view.projectId`、`taskQuestions.length > 0` 直接决定，不查 `isResidentPanel` / `panelPlacement`。
- 顶栏入口打开哪一页由组件内 `openDrawerRoot()` 自己决定（有草稿就开草稿，否则开第一个任务），策略模块没有导出定位规则。入口也不能定位到某个指定任务；有草稿时点击永远落到草稿页，要看任务还得再点「任务 N」。

因此「conversation-drawer.ts 是什么留在聊天、什么进抽屉的唯一事实来源，组件不得绕过它硬编码」没有成立。这是缺陷 1 能溜过纯逻辑测试的原因。

## 已核对且成立的部分

- 草稿卡 `proposal-draft`、确认控件 `accept-branch` / `confirm-draft`、任务列表 `conversation-task-<id>`、节点清单 `conversation-nodes-<id>`、目标分支/集成提交/费用，都在 `aside[data-testid=detail-drawer]` 内（Conversation.tsx 1206–1368），不在 `.conversation-thread-inner`。
- 抽屉默认收起：`defaultDrawerOpen()` 返回 false；`App.tsx:136` `useState(false)`，换路由时 `setDetailOpen(false)`。收起时 `data-open=false`、`aria-hidden`、`inert`，样式把宽度收到 0。
- 顶栏 `drawer-entry` 在抽屉收起时仍在头部，文案来自 `drawerEntryLabel`，形如「草稿 vN · 待确认/已确认/已过期 · 任务 N」，不是纯图标。`aria-expanded` 与 `drawerOpen` 同步。
- 待答功能任务问题独立渲染在聊天流（`conversation-questions` / `conversation-questions-<taskId>`），不嵌在任务卡里，沿用 `QuestionReply`；没有待答问题时该区块不渲染。
- 抽屉草稿页含版本 TOC、验收项、节点、决策、任务图（`GraphCanvas`，四态图例仍由画布渲染，`testid=legend` 未改）。任务导航列出全部任务，选中后有状态/目标分支/集成提交/费用、节点清单，以及「打开任务 / 打开任务图」链接。
- diff 仅 8 个文件，全部在节点 `input.files` 内。`styles.css` 未改（新样式在 `conversation-drawer.css`）。`tests/m8/ui-flow.test.ts`、`tests/m5/ui.test.ts`、`package.json` 未改。没有新增依赖，没有改 IPC/Electron/Pi SDK/服务端配置。
- 被改的 playwright 测试是按新位置重写：仍断言草稿摘要、确认控件、任务图四态图例、节点状态、任务数量，并额外断言这些块不在 `.conversation-thread-inner`。不是删断言换绿。它们没有在宿主门禁里重跑；那是后续人工/宿主验收范围，不是本次失败原因。
- 程序检查：`check-types` code 0；`check-chat-containment` 10 tests passed；`check-batch-c-intact`（branch-naming、graph-board-state、recipe-compile）28 tests passed。批 C 源文件不在本次 diff 中。

## 建议

把 `no-conversation-tasks` 与 `bind-project` 移出 `.conversation-thread-inner`（空任务提示可进抽屉任务导航，绑定项目若必须当场操作则应明确纳入常驻策略并得到验收确认，而不是留在聊天流里当卡片）。让渲染位置只由 `conversation-drawer.ts` 的集合决定，并给纯逻辑测试补上「聊天流切片不含 thread-action-card / bind-project / no-conversation-tasks」的断言。
