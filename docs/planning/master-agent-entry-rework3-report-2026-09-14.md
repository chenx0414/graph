# 主 Agent 入口：第三轮返工报告

日期：2026-09-14。状态：**ME-R04-R2 与 ME-R08-R1 已修复并本地验证；等待独立复验。** 本文不宣布整体通过。验收见 [第二轮返工独立验收](master-agent-entry-rework2-acceptance-2026-09-14.md)，前两轮修复见 [第一轮](master-agent-entry-rework-report-2026-09-14.md)、[第二轮](master-agent-entry-rework2-report-2026-09-14.md) 报告。

## 基线、分支与提交

- 被验收基线：`ff0e7666439bf6e1e62f0ddda4c6a10376547bcd`（固定比较 `6cec5aa...ff0e766`）。
- 工作树：`/Users/macmini/workspace/graph-master-entry-dev`，分支 `feat/master-agent-entry`。修复提交：`714ce2a`（缓存状态同步与显式空决策）；其后提交仅为文档/证据更新。未合并、未覆盖 `main`、`feat/app-console` 或主工作区文件。

## 逐项修复

### ME-R04-R2 / P2 缓存不能补齐中间缺页，也不能同步历史消息状态

根因有两点：

1. 浏览器缓存只合并“最新窗口 + 向前历史页”，没有补齐突发的中间缺口；把“缓存条数少于总数”一律当作“最早记录之前还有历史”，于是缺口存在时点“载入更早消息”请求的是最早已缓存记录之前，返回空页后错误地认为已到尽头。
2. 用户消息 `pending → delivered`（以及派发失败回到 `pending`）在数据库里是批量状态更新，没有对应事件；浏览器缓存不包含该记录时，后续最新窗口刷新也看不到它，状态永远停在 pending。

修复：

- **内核发布状态变化**：主管轮次消费消息（标记 `delivered`）与派发前失败回队（标记 `pending`）时，逐条发布 `message.updated` 事件（`execution.ts` 消费事务、`conversation.ts` 的 `releaseMessages`）。事件载荷是完整消息记录。
- **浏览器缓存完整同步契约**（`Conversation.tsx`）：
  - 单一缓存按稳定 ID 合并、按 `seq` 排序；所有来源（最新窗口、历史页、流事件）共用同一合并函数，`updatedAt` 较旧的记录不能覆盖较新的状态，迟到的历史响应不会让状态倒退。
  - `message.updated` 总是合并；`message.created` 只合并比当前缓存最新的记录，避免事件重放绕过分页（历史由最新窗口与显式历史页负责）。
  - “载入更早消息”先检测缓存中的 `seq` 缺口，从缺口前一条用 `after` 向前补齐一页；没有缺口才用 `before` 向历史回溯。只有向历史请求返回空页才标记“已到尽头”，缺口不再被误判为尽头。
- 回归：内核测试 `message state changes are published so incremental caches stay in sync`（消费后 `message.updated` 含 `delivered`；派发失败回队含 `pending`）；浏览器测试 `conversation-history-ui.test.ts` 新增“先加载 20 条再突发 260 条”——中间记录可达、无重复、共 280 条；以及“加载全部历史后由主管分批处理 220 条”——缓存中的第一条从 pending 更新为 delivered，无需整页刷新。
- 复验证据：独立探针 `history-cache-consistency.mts` 两个场景均 `passed: true`（`burst-middle-page-gap`：`beforeHistory/afterHistory: 280`、`gapBefore/gapAfter: false`；`loaded-history-state-refresh`：UI `delivered` 与账本一致）。既有 501 条三页、单条新增、A/B 切换契约保持通过。

### ME-R08-R1 / P2 显式空决策列表触发回退，重新带入已撤销约束

- 根因：`if (curated.length)` 把“未提供 `decisions` 字段”和“明确提供 `decisions: []`”混为一谈；后者表示主管已删除全部有效约束，却回退到已消费聊天原文。
- 修复：按字段是否存在区分（`Array.isArray(proposal.decisions)`）。显式列表（含 `[]`）是主管的权威快照：空列表冻结为空字符串，确认卡、存储快照与工人说明包三处一致，不回填任何聊天；只有字段缺省的旧/脚本化提案走兼容回退（当前项目绑定内已消费用户消息）。确认卡对显式空列表显示「主管已声明本任务没有需要传递的决策或约束」。
- 回归：内核测试 `an explicit empty decisions list revokes constraints without falling back to chat`：撤销后 `decisions: []` 冻结为空，工人说明包不再含旧约束；同会话后续新功能显式 `[]` 也不继承前一任务内容。既有非空列表、旧项目隔离、草稿后 pending 排除、冻结后聊天等契约保持。
- 复验证据：独立探针 `decision-empty-snapshot.mts` 现在 `confirmationSnapshot: ""`、`workerReceivesWithdrawnConstraint: false`、`passed: true`。

## 证据记录修正

上一轮 `master-agent-entry-rework2/verification.output.txt` 中 `queued-usage-pi` 与 `master-readonly-capability` 两段因路径写错（指向了 `master-agent-entry-rework-independent`，而这两个探针位于第一轮的 `master-agent-entry-independent`），实际是 `MODULE_NOT_FOUND` 却因管道退出码被记录成 `rc=0`。本轮改为：正确绝对路径、输出重定向到文件后用 `$?` 记录被测进程真实退出码，并逐项核对输出语义。10 个独立探针输出与真实退出码见 `acceptance-evidence/master-agent-entry-rework3/probes/`。

## 工程验证

- `tsc --noEmit`、`tsc -p tsconfig.web.json --noEmit`、`vite build` 通过（真实 `rc=0`）。
- `vitest run` **两轮均为 53 文件 / 247 项通过**（上轮 53/243 + 消息状态内核回归 + 两个浏览器缓存回归 + 显式空决策回归）。
- 独立探针（真实退出码，全部 rc=0，输出逐项核对）：
  - 本轮反例：`history-cache-consistency`（2/2 passed）、`decision-empty-snapshot`（passed）。
  - 上轮：`readonly-remote-mcp`（effects 0）、`message-history-ui`（3/3 passed）、`bind-decision-contract`（三场景修正）、`remote-mcp-mode-contract`（3/3 passed，effects 0/0/1）、`reconcile-ui-restart`。
  - 更早：`queued-usage-pi`（两种核对 passed）、`master-readonly-capability`（projectWrite null）、`conversation-ui-boundaries`（问题可见、工人状态实时）。
  - 交付方 `rework-probes.mts` rc=0。
- 8 个历史沙箱/监听探针全部 rc=0。
- 全部使用本地受控供应商、脚本化 adapter 与无头 Chromium，未调用付费模型。

汇总输出：`acceptance-evidence/master-agent-entry-rework3/verification.output.txt`；逐探针输出：`.../rework3/probes/*.output.txt`。

## 独立复现

```sh
cd /Users/macmini/workspace/graph-master-entry-dev
export PATH="$PWD/node_modules/.bin:$PATH"
./node_modules/.bin/tsc --noEmit && ./node_modules/.bin/tsc -p tsconfig.web.json --noEmit
./node_modules/.bin/vite build
./node_modules/.bin/node docs/planning/acceptance-evidence/master-agent-entry-rework/rework-probes.mts
./node_modules/.bin/vitest run tests/m8/conversation.test.ts tests/m8/conversation-history-ui.test.ts
./node_modules/.bin/vitest run
D=/Users/macmini/workspace/13-Graph/docs/planning/acceptance-evidence/master-agent-entry-rework2-independent
./node_modules/.bin/node "$D/history-cache-consistency.mts"; echo rc=$?
./node_modules/.bin/node "$D/decision-empty-snapshot.mts"; echo rc=$?
```

## 剩余边界

- 长会话自动摘要未实现（未启用 Pi compaction、未做长上下文负载验证），需范围决定后单独一轮。
- 远程 MCP 讨论期完全不可用（已明确交付边界）；执行期仍按任务 grant 逐调用校验。
- 决策“约束抽取/撤销”的主管理路径由主管维护 `decisions`；脚本化/缺省提供者走回退快照，不具备语义撤销。
- 真实付费模型的理解、追问与决策维护质量仍未评估。
