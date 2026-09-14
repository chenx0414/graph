# 主 Agent 入口：第四轮返工报告

日期：2026-09-14。状态：**ME-R04-R3 已修复并本地验证；等待独立复验。** 本文不宣布整体通过。验收见 [第三轮返工独立验收](master-agent-entry-rework3-acceptance-2026-09-14.md)。

## 基线、分支与提交

- 被验收基线：`46b31b6c95f582a0dc328ec1176887700ea1dd4b`（固定比较 `ff0e766...46b31b6`）。
- 工作树：`/Users/macmini/workspace/graph-master-entry-dev`，分支 `feat/master-agent-entry`。修复提交：`6d1531b`（按会话自有游标分页 + 严格递增消息版本）；其后提交仅为文档/证据更新。未合并、未覆盖 `main`、`feat/app-console` 或主工作区文件。

## ME-R04-R3 / P2 全局序号被当作会话连续序号，分页停滞

- 根因：`messages.seq` 是全表 `AUTOINCREMENT`，被所有会话共用。上一轮为了补齐突发缺页，用“相邻缓存记录 `seq` 差 > 1”判定缺页；两个会话交错发言时，同一会话内部 `seq` 跳跃是正常现象。判定为缺页后优先发 `after=<已有消息 seq>`，返回的全是已缓存消息，缓存不增长、游标不前进，真正的早期历史永远轮不到 `before` 分页（修复前基线能正常加载全部，属本轮回归）。
- 修复（`src/web/Conversation.tsx`）：
  - 取消按整数连续性判定缺页；`hasOlder` 只由“已缓存条数 < 会话消息总数”决定。
  - “载入更早消息”始终先按会话自身过滤向历史回溯：`before = 最早已缓存 seq`；只有该请求返回空页（确实到达会话首条）且仍有缺失时，才进入中间缺口补齐。
  - 中间缺口用持久化前瞻游标扫：起点取“最新窗口之前已缓存的最后一个 seq”，每次 `after=<游标>&limit=200`，合并后将游标推进到该页最后一条。返回页即使全部已缓存，游标也前进，不会重复请求同一游标；只有 `after` 返回空页才标记真正到尽头。
  - 保留稳定 ID 去重、历史窗口与实时尾部合并、`updatedAt` 防倒退。
- 非阻断建议一并落实：消息状态更新的 `updated_at` 改为 `MAX(?, updated_at+1)`，保证同一毫秒内的 `delivered → pending` 等转换仍有严格递增版本；独立探针的 `sameMillisecondTransitions` 从 21/30 变为 0。
- 回归（`tests/m8/conversation-history-ui.test.ts`）：
  - 新增 `interleaved conversations page by their own records, not by global sequence steps`：A、B 各交错写入 501 条，A 200→400→501，最早记录可见、按钮消失、无外来消息；随后交错再突发 260 条 A 消息，UI 补齐到 761 条且中间记录不重复、不缺失。
  - 既有单会话 501 条三页、20+260 突发、220 条状态同步、A/B 切换、后退与在途切换用例保持通过。
- 复验证据：独立探针 `history-global-seq.mts` 现在 `afterClicks: [400,501,501]`、`historyRequests: ["?before=603…","?before=203…"]`、`earliestVisible: true`、`foreignConversationMessages: 0`、`passed: true`。

## 工程验证

- `tsc --noEmit`、`tsc -p tsconfig.web.json --noEmit`、`vite build` 真实退出 0。
- `vitest run` **两轮均为 53 文件 / 248 项通过**（上轮 247 + 交错分页回归）。
- 独立探针（真实退出码，逐项核对语义）：本轮 `history-global-seq`（passed）、`history-cache-consistency`（2/2 passed）、`message-state-millisecond`（同毫秒转换 0）、`decision-empty-snapshot`（passed）、`conversation-ui-boundaries`（passed）；上轮 `queued-usage-pi`（两种核对 passed）、`master-readonly-capability`（projectWrite null）、`readonly-remote-mcp`（effects 0）、`message-history-ui`（3/3 passed）、`bind-decision-contract`（三场景修正）、`remote-mcp-mode-contract`（3/3 passed）、`reconcile-ui-restart`；交付方 `rework-probes.mts` rc=0。
- 8 个历史沙箱/监听探针全部 rc=0。
- 全部使用本地受控供应商、脚本化 adapter 与无头 Chromium，未调用付费模型。
- 汇总：`acceptance-evidence/master-agent-entry-rework4/verification.output.txt`；逐探针输出：`.../rework4/probes/*.output.txt`。

## 独立复现

```sh
cd /Users/macmini/workspace/graph-master-entry-dev
export PATH="$PWD/node_modules/.bin:$PATH"
./node_modules/.bin/tsc --noEmit && ./node_modules/.bin/tsc -p tsconfig.web.json --noEmit
./node_modules/.bin/vite build
./node_modules/.bin/vitest run tests/m8/conversation-history-ui.test.ts
./node_modules/.bin/vitest run
D=/Users/macmini/workspace/13-Graph/docs/planning/acceptance-evidence/master-agent-entry-rework3-independent
./node_modules/.bin/node "$D/history-global-seq.mts"; echo rc=$?
./node_modules/.bin/node "$D/history-cache-consistency.mts"; echo rc=$?
./node_modules/.bin/node "$D/message-state-millisecond.mts"; echo rc=$?
```

## 剩余边界

- 长会话自动摘要未实现（未启用 Pi compaction、未做长上下文负载验证），需范围决定后单独一轮。
- 远程 MCP 讨论期完全不可用（已明确交付边界）；执行期仍按任务 grant 逐调用校验。
- 决策“约束抽取/撤销”的主管理路径由主管维护 `decisions`；脚本化/缺省提供者走回退快照，不具备语义撤销。
- 真实付费模型的理解、追问与决策维护质量仍未评估。
