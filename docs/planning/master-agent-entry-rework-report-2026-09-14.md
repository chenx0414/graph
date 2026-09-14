# 主 Agent 入口：独立验收返工报告

日期：2026-09-14。状态：**ME-S01 与 ME-R01–R06 已修复并本地验证；等待独立复验。** 本文不宣布整体通过。独立验收报告见 [master-agent-entry-acceptance-2026-09-14](master-agent-entry-acceptance-2026-09-14.md)，原实施报告见 [master-agent-entry-report-2026-09-14](master-agent-entry-report-2026-09-14.md)，决策见 [ADR 0009](../adr/0009-conversation-first-master-entry.md)。

## 基线、分支与提交

- 验收基线：`c0247abd59d2e2ba3a9a6a620d0205ad64a6ced2`（独立验收固定比较 `688dd1f...c0247ab`）。
- 工作树：`/Users/macmini/workspace/graph-master-entry-dev`，分支 `feat/master-agent-entry`。返工提交接在 `c0247ab` 之后，未合并、未覆盖 `main`、`feat/app-console` 或主工作区现有文件。

## 逐项修复

### ME-S01 / P1 讨论阶段绑定扩展能写业务文件

- 根因：讨论只通过 `agentTools({readOnly:true})` 移除了内建写工具，但 `loadCapabilities` 原样把 `capabilities.tools` 加入工具集；本地 MCP 与扩展的受限进程仍以 `writePaths: [workspace, scratch]` 运行。
- 修复：`loadCapabilities` 新增 `readOnly`，传入 讨论模式时 本地 MCP（`localConnection`）与扩展（`extensionConnection`）的受限执行 `writePaths` 只保留宿主 scratch；扩展 `register()` 初始化与每次工具调用共用该限制，因此讨论期不能写业务目录。远程 MCP 无宿主文件系统访问，仍按既有任务 grant 逐工具校验；报告明确该边界。
- 回归：`tests/m8/conversation-readonly.test.ts`：真实 Pi + 受控 provider + 已安装扩展。讨论轮调用扩展写文件被拒（业务目录无文件），确认后的工人用同一扩展成功写入（正对照，证明限制来自讨论模式而非能力损坏）。
- 复验证据：独立探针 `master-readonly-capability.mts` 现在输出 `"projectWrite": null`（原为 `"extension capability write"`）。

### ME-R01 / P1 未知用量核对后排队消息不再处理

- 根因：`settle()` 已因会话有待处理消息把主管节点保持 `pending`，但 `answer()` 的通用恢复逻辑只按“当前 activation 的最新操作 completed”把节点改回 `succeeded`，覆盖了排队状态。
- 修复：恢复判定同时考虑会话待处理消息（`conversationForTask` + `pendingMessages`）：只要仍有排队消息，主管节点保持 `pending`；没有排队时才按 completed 恢复。activation 隔离与 PA02-R5 语义不变。
- 回归：内核测试 `reconciling unknown usage continues the message queued during the blocked turn`（`usage` 与 `reconcile_usage` 两种方式各断言第二次供应商请求与第二条回复）。
- 复验证据：独立探针 `queued-usage-pi.mts` 两种方式均 `passed: true`、`providerRequests: 2`。

### ME-R02 / P1 聊天页看不到也无法答复主管阻塞问题

- 根因：会话 DTO 只带功能任务的问题；页面只为功能任务渲染答复组件；anchor 任务又不在任务列表中，用户没有恢复入口。
- 修复：`conversations.view` 增加 `questions`（anchor 全部问题，带 `taskId`）与 `master.questions`（open）；会话页新增「主 Agent 需要你的处理」区，复用已验证的 `QuestionReply`（未知用量两种核对、预算、权限、执行失败等），`data-testid="master-questions"`。
- 回归：`tests/m8/conversation-boundaries-ui.test.ts` 通过真实 Chromium 打开页面、看到 `unknown_usage` 原因与控件、在 UI 内补记用量并让排队消息继续；另有截图 `06-master-question.png`。
- 复验证据：独立探针 `conversation-ui-boundaries.mts` 现在 `canFindUnknownUsage: true`、`visibleControls` 含「答复」。

### ME-R03 / P1 切换项目后旧项目草稿仍可确认执行

- 根因：`bind` 只改项目引用；`confirm` 不校验草稿对应的项目身份。
- 修复：`bind` 从已绑定项目切换到不同项目时，把 anchor 的 `requirement_version` +1 并写入系统说明与 `conversation.rebound` 事件，使所有已生成的草稿立即成为 stale；`confirm` 继续要求“当前需求版本上的最新草稿”，因此旧草稿被服务端拒绝，陈旧页面同样无法确认。未绑定时首次绑定不改变需求版本，正常路径保留。
- 回归：内核测试 `rebinding a conversation invalidates drafts investigated for the previous project`：A 草稿确认得到 `stale_proposal`，在 B 重新提案后可正常确认且任务属于 B。
- 复验证据：独立探针 `bind-and-message-pagination.mts` 现在在确认旧 v1 时抛出 `stale_proposal`（`bind-probe-after-fix.output.txt`），即“A 草稿不能在 B 执行”；分页部分由 `rework-probes.mts` 与浏览器测试接续覆盖。

### ME-R04 / P2 超过 200 条后 Web 看不到新消息

- 根因：`listMessages` 只按 `seq` 正序返回最早 200 条，前端始终只取默认页。
- 修复：消息分页改为“默认最新窗口”：无参数返回最新 N 条（升序），`after` 向前增量，`before` 向历史回溯；`view` 返回 `messageCount`；会话页增加「载入更早消息」按钮并保留已加载历史，新消息仍实时出现。
- 回归：内核测试 `the default message page shows the newest records and older history stays reachable`（202 条：默认 200 条、最后为 message-201、`before` 取回开头、`after` 为空）；浏览器测试在 210 条后断言最新可见并可载入更早（截图 `08-message-paging.png`）。
- 复验证据：`rework-probes.mts` 的 `message-pagination` 检查 `passed: true`。

### ME-R05 / P2 工人状态变化不实时更新会话侧栏

- 根因：页面只订阅 anchor 任务的 SSE，功能任务事件属于另一 taskId。
- 修复：`conversations.watch` 改为会话范围的多任务流（anchor + 所有 `conversation_id` 关联任务，每轮重新读取任务集合，新任务无需重连）；会話 SSE 端点沿用同一 cursor 语义与去重；页面改用 `/api/conversations/:id/events/stream`。
- 回归：浏览器测试在不刷新页面的情况下等待工人 `running → succeeded`，与账本状态一致（截图 `07-live-worker-status.png`）。
- 复验证据：独立探针 `conversation-ui-boundaries.mts` 的 `feature-task-live-status` 现在 `passed: true`（`uiAfter == ledgerAfter`）。

### ME-R06 / P2 费用漏算主管，未知费用显示成 0

- 根因：页首费用与 unknown 标记只聚合 `view.tasks`，纯聊天时为空。
- 修复：会话投影聚合主管 invocation 费用与功能任务费用（`cost`、`usage`）；主管存在 open `unknown_usage` 问题时按“费用未知”投影（脚本化适配器或恢复结算前尚无定价 invocation 的场景也一样）；页面显示聚合后的 `view.cost` 与 `view.usage.used`。
- 回归：`rework-probes.mts` 的 `unknown-cost-and-decision-digest`（`unknownCost: true`）；浏览器测试断言页首「费用未知」。
- 复验证据：独立探针页首现在为 `已计量 0 tokens · 费用未知`（原为 `费用 0`）。

## 方案范围进展与仍未闭合项

- 已补：**面向子 Agent 的决策/约束摘要**。确认草稿时把提案摘要与最近 10 条用户消息快照为功能任务的 `decision_digest`（schema v12），子 Agent 说明包含 `Decisions and constraints from the conversation`；内核测试与 `rework-probes.mts` 验证。
- 已补：**草稿图与回边呈现**。会话页从只读接口 `/api/conversations/:id/draft-graph` 渲染草稿图（ELK 布局），列表显示返工回边；浏览器测试断言草稿图出现；确认信息包含目标分支、验收项、节点、模型与定义。
- 仍未闭合：**长会话自动摘要**。主管会话仍关闭 Pi compaction，超长对话的上下文增长策略未实现，也未做负载验证。建议单独一轮有界实现在受控长上下文下验证（摘要调用同样经过发送门与预算），本轮不把它当作已完成。

## 工程验证

- `tsc --noEmit`、`tsc -p tsconfig.web.json --noEmit`、`vite build` 通过。
- `vitest run` **两轮均为 52 文件 / 240 项通过**（原 50/234 + 新增 4 项内核回归 + 只读扩展回归 + 浏览器边界回归）。
- 独立验收的 4 个新探针：`queued-usage-pi` 两种核对通过；`master-readonly-capability` 业务目录无写入；`conversation-ui-boundaries` 问题可见可答且工人状态实时；`bind-and-message-pagination` 在旧草稿确认处按预期抛出 `stale_proposal`（分页由内核与浏览器回归接续）。
- 8 个历史沙箱/监听探针全部 rc=0。
- 输出汇总：`acceptance-evidence/master-agent-entry-rework/verification.output.txt`；内核返工探针：`.../rework-probes.mts` + `.output.txt`；浏览器截图：`acceptance-evidence/master-agent-entry/06-master-question.png`、`07-live-worker-status.png`、`08-message-paging.png`（01–05 也由本轮浏览器测试重新生成）。
- 未调用付费模型；全部使用本地受控 provider、脚本化 adapter 与无头 Chromium。

## 独立复现步骤

```sh
cd /Users/macmini/workspace/graph-master-entry-dev
export PATH="$PWD/node_modules/.bin:$PATH"
./node_modules/.bin/tsc --noEmit && ./node_modules/.bin/tsc -p tsconfig.web.json --noEmit
./node_modules/.bin/vite build
./node_modules/.bin/node docs/planning/acceptance-evidence/master-agent-entry-rework/rework-probes.mts
./node_modules/.bin/vitest run tests/m8/conversation.test.ts tests/m8/conversation-readonly.test.ts
./node_modules/.bin/vitest run tests/m8/conversation-pi.test.ts tests/m8/conversation-boundaries-ui.test.ts tests/m8/conversation-ui.test.ts
./node_modules/.bin/vitest run
# 独立验收探针（bind 探针在旧草稿确认处应抛出 stale_proposal）：
./node_modules/.bin/node /Users/macmini/workspace/13-Graph/docs/planning/acceptance-evidence/master-agent-entry-independent/queued-usage-pi.mts
./node_modules/.bin/node /Users/macmini/workspace/13-Graph/docs/planning/acceptance-evidence/master-agent-entry-independent/master-readonly-capability.mts
./node_modules/.bin/node /Users/macmini/workspace/13-Graph/docs/planning/acceptance-evidence/master-agent-entry-independent/conversation-ui-boundaries.mts
```

## 剩余边界

- 远程 MCP 在讨论期仍可被调用（无宿主文件系统写权限，且每次调用按任务 grant 校验）；若要讨论期完全禁止外部能力，需要另行决定范围。
- 长会话自动摘要未实现（见上）。
- 交互优先仍是“主管先于图节点派发”，凭据队列 FIFO。
- 真实付费模型的理解、追问与交流质量仍未评估，按计划在机制关闭后另做有界真实对话。
