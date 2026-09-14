# 主 Agent 入口：第二轮返工报告

日期：2026-09-14。状态：**ME-S01-R1、ME-R04-R1、ME-R07、ME-R08 已修复并本地验证；等待独立复验。** 本文不宣布整体通过。返工验收见 [master-agent-entry-rework-acceptance-2026-09-14](master-agent-entry-rework-acceptance-2026-09-14.md)，第一轮返工见 [master-agent-entry-rework-report-2026-09-14](master-agent-entry-rework-report-2026-09-14.md)，决策见 [ADR 0009](../adr/0009-conversation-first-master-entry.md)。

## 基线、分支与提交

- 被验收基线：`6cec5aa474b3946751e6ad45a71e3ca247ca7717`（固定比较 `c0247ab...6cec5aa`）。
- 工作树：`/Users/macmini/workspace/graph-master-entry-dev`，分支 `feat/master-agent-entry`。返工提交在本文件提交后列出（见提交记录）。未合并、未覆盖 `main`、`feat/app-console` 或主工作区文件。

## 逐项修复

### ME-S01-R1 / P1 讨论期 HTTP MCP 仍可写业务文件

- 根因：`readOnly` 只传给本地 stdio MCP 与扩展；HTTP/远程分支仍按既有工具 grant 加载全部工具。HTTP 只是传输方式，本机或远端服务都可能操作业务资源，既有写 grant 与当前讨论约束应同时满足。
- 修复：讨论模式下远程 MCP 工具不加载（连 `tools/list` 都不发）；讨论期支持的只读调查范围明确为：内建读取/目录、能力快照读取、本地 MCP/扩展读取（业务目录对它们只读）、受控网络检索。远程工具只在执行期加载，并继续按任务 `mcp:<capability>:<tool>` grant 逐调用校验；不依据服务自报注解放行。
- 回归：`tests/m8/conversation-readonly.test.ts` 新增本机 HTTP MCP 用例：项目预授予 `mcp:remote:write_business`，讨论轮模型请求该工具，断言工具未出现在工具集、`effects === 0`、业务文件内容不变。
- 复验证据：独立探针 `readonly-remote-mcp.mts` 现在输出 `effects: 0`、`business: "original business file"`。

### ME-R04-R1 / P2 历史游标不推进、滑动窗口出现缺口

- 根因：`oldestSeq` 取当前最新窗口的第一条，而非已加载历史的最早记录；最新窗口更新时旧的已显示记录没有保留在缓存。
- 修复：会话页维护按稳定 ID 合并、按 `seq` 排序的消息缓存；最新窗口与历史页都合并进同一缓存；历史游标始终取缓存中最早 `seq`；`messageCount` 与缓存长度决定是否还有历史，到尽头隐藏并停止。新消息到达时缓存保留旧记录，窗口移动不再产生缺口。
- 回归：`tests/m8/conversation-history-ui.test.ts`：501 条消息连续三页到 A-message-000、第三次加载后按钮消失；新增消息后 A-message-301 不消失且总数 502；A→B→返回都不串消息；历史请求在途时切换会话不影响 B。
- 复验证据：独立探针 `message-history-ui.mts` 三个场景全部 `passed: true`（`afterSecond: 501`、`firstAccessible: true`、`retained301: true`、`foreignConversationMessages: 0`）。

### ME-R07 / P2 切换会话后旧会话历史混入新会话

- 根因：`ConversationPanel` 在会话 ID 变化时复用同一组件实例，`older`/流式/工具状态没有按会话隔离；迟到的历史响应可能写入新会话。
- 修复：App 用 `key={conversationId}` 重新挂载面板，所有会话内状态（消息缓存、历史游标、流式文字、工具活动、草稿）随会话生命周期隔离；视图加载沿用按 deps 分代的 `useAsync`，历史加载结果只合并到挂载它的会话缓存。
- 回归：同上浏览器测试覆盖 A→B 直接切换、浏览器后退返回 A、历史请求在途切换三类路径。
- 复验证据：独立探针 `message-history-ui.mts` 的 `conversation-switch-history` 现在 `foreignConversationMessages: 0`。

### ME-R08 / P2 决策摘要遗漏早期约束并混入旧项目/未确认聊天

- 根因：确认时从整个会话取最近 10 条 user 原文并直接标为决策；未绑定草稿版本、未按项目绑定划分、也未区分已消费与待讨论消息。
- 修复：
  - `Proposal` 新增可选 `decisions: string[]`（校验：≤50 条、每条 ≤800 字、非空）。主管提案时以它维护“当前有效约束”，撤销即在新草稿中删除；`propose_graph` 工具说明与主管提示同步要求维护该列表。
  - 草稿创建时**冻结决策快照**：有 `decisions` 用主管理的列表逐条渲染；否则回退为“该会话当前项目绑定内已被主管消费（`state='delivered'`）的全部用户消息”，带 `[msg seq]` 来源引用。快照写入 `proposals.decision_snapshot`（schema v13）。
  - 换项目时记录 `conversations.binding_since_seq`，新草稿只取换绑之后的已消费消息；旧项目内容不再串入。
  - 草稿发布之后到达的消息（含 pending）不进入快照；`confirm` 只复制该快照到 `tasks.decision_digest`，子 Agent 说明包与确认卡因此是同一份内容；确认卡显示「确认后原样交给工人的决策/约束」，并补充额度说明。
- 回归：`tests/m8/conversation.test.ts` 新增四个场景：A 约束不进入 B 工人说明包；早期约束经过十轮讨论仍在；草稿后 pending 消息不进入且草稿卡可见性由快照决定；主管理 decisions 原文冻结。
- 复验证据：独立探针 `bind-decision-contract.mts` 现在 `binding` 的 B 工人说明不含 `A_ONLY`、`long-constraint` 的 `workerHasPersistentConstraint: true`、`after-draft` 的 `workerHasUnreviewedNextTask: false`。

## 确认信息补全

- 确认卡现在展示：项目与目标分支、草稿版本与需求版本、验收项、节点/模型/定义、返工回边、**冻结的决策/约束快照**、以及额度说明（主管已用/预算；确认后每个 Agent 实例默认额度 20,000,000，由执行内核逐调用预留与结算）。
- 长会话自动摘要仍未实现：本轮未启用 Pi compaction，也未做长上下文负载验证。需要范围决定后单独一轮实现与验证，不能据现有机制宣称该 P1 已闭合。

## 工程验证与证据

- `tsc --noEmit`、`tsc -p tsconfig.web.json --noEmit`、`vite build` 通过。
- `vitest run` **两轮均为 53 文件 / 243 项通过**（上轮 52/240 + 历史缓存浏览器回归 + 决策快照内核回归 + 远程 MCP 讨论只读回归）。
- 独立目录探针：`readonly-remote-mcp`（effects 0）、`message-history-ui`（三场景 passed）、`bind-decision-contract`（三场景修正）、以及上轮 `queued-usage-pi`、`master-readonly-capability`、`conversation-ui-boundaries` 与交付方 `rework-probes.mts` 全部符合修复后语义。
- 8 个历史沙箱/监听探针全部 rc=0。
- 全部使用本地受控供应商、脚本化 adapter 与无头 Chromium，未调用付费模型。
- 汇总输出：`acceptance-evidence/master-agent-entry-rework2/verification.output.txt`；浏览器截图：`acceptance-evidence/master-agent-entry/01–09*.png`（含新增会话切换截图）。

## 独立复现

```sh
cd /Users/macmini/workspace/graph-master-entry-dev
export PATH="$PWD/node_modules/.bin:$PATH"
./node_modules/.bin/tsc --noEmit && ./node_modules/.bin/tsc -p tsconfig.web.json --noEmit
./node_modules/.bin/vite build
./node_modules/.bin/node docs/planning/acceptance-evidence/master-agent-entry-rework/rework-probes.mts
./node_modules/.bin/vitest run tests/m8/conversation.test.ts tests/m8/conversation-readonly.test.ts
./node_modules/.bin/vitest run tests/m8/conversation-history-ui.test.ts tests/m8/conversation-boundaries-ui.test.ts tests/m8/conversation-ui.test.ts
./node_modules/.bin/vitest run
# 独立验收探针（均为证据收集器，退出 0 也需核对输出语义）：
D=/Users/macmini/workspace/13-Graph/docs/planning/acceptance-evidence/master-agent-entry-rework-independent
./node_modules/.bin/node "$D/readonly-remote-mcp.mts"
./node_modules/.bin/node "$D/message-history-ui.mts"
./node_modules/.bin/node "$D/bind-decision-contract.mts"
```

## 剩余边界

- 长会话自动摘要未实现（见上）。
- 决策快照的“约束抽取/撤销”在主管理 `decisions` 路径上由主管负责；脚本化/旧提供者走回退快照（全部已消费消息），不具备语义撤销能力。真实模型的决策维护质量属于尚未评估的对话质量范围。
- 远程 MCP 在讨论期完全不可用；如果后续需要讨论期只读远程调用，需要引入宿主显式认可的只读工具清单与相应授权界面。
- 交互优先仍是“主管先于图节点派发”，凭据队列 FIFO；真实付费模型对话质量仍未评估。
