# U01 默认不限累计 token：实施与验证报告

日期：2026-09-15。分支 `feat/unified-console`。契约见 [ADR 0010](../adr/0010-unified-console-contracts.md)，计划见 [统一控制台实施计划](unified-console-roadmap-2026-09-15.md)。基线 `8cd1523`（U00）。

## 交付内容

- **schema v14**（`src/core/store.ts`）：`instances` 新增 `unlimited INTEGER NOT NULL DEFAULT 0`。迁移只加列，不改写任何存量行；旧实例保持原 `budget`/`used` 且 `unlimited=0`（有限）。数据库版本上限从 13 提升到 14。
- **新实例默认不限**（`src/core/task-runtime.ts`）：所有实例创建点（`begin` 主管、`createMasterNode`、`accept`、会话 `confirm`、`applyRevision`）统一走 `insertInstance`；默认 `unlimited=1, budget=0`。`limits.defaultBudgetTokens` 为正整数时创建有限实例（`unlimited=0, budget=该值`），为 `null`/缺省时不限；非法值在启动时以 `invalid_input` 拒绝，不猜测。
- **门禁语义**（`src/runtime/task-gate.ts`、`src/core/execution.ts`、`src/core/revision.ts`）：只有预算比较在 unlimited 时跳过；暂停、未知用量、权限、名额、凭据并发、实例身份、恢复、预留与逐调用结算全部保留。预留与 `used` 仍是有限整数；`add_budget` 对无限实例返回 `invalid_answer`，不会悄悄造出预算问题。
- **显式策略转换**（`runtime.user.task(id).setBudget({ nodeId, tokens, requestId })` + `POST /api/tasks/:id/budget`）：`tokens=null` 切为不限，正整数切为有限；幂等、记 `instance.budget_changed` 事件；切为不限时只结束该节点的 `budget` 问题并让空闲节点回到 `pending`，权限/未知用量问题不受影响。实例身份、`used`、历史记录不变。
- **配置**（`src/server/config.ts`、`start.ts`）：`limits.defaultBudgetTokens` 解析为可空正整数，传入 runtime；默认 `null`。
- **界面**：任务页用量统计显示「不限」而不是 0/未知/溢出百分比（`src/web/insights.ts`、`App.tsx`）；图节点详情显示「额度不限」；会话草稿卡不再宣称 20,000,000 默认；`docs/graph-mvp.md` 已同步。
- **既有有限额度语义保留**：m1/m2/m3/m5 中验证预算门禁的用例显式固定 `limits.defaultBudgetTokens: 20_000_000`，旧含义不变。

## 验证

- `tsc --noEmit`、`tsc -p tsconfig.web.json --noEmit`、`vite build` 全部 rc=0。
- `vitest run`：**58 → 59 文件 / 292 项通过**（新增 `tests/console/unlimited.test.ts` 5 项与 `tests/console/unlimited-ui.test.ts` 1 项）。
- 新增用例：
  1. 同一实例首轮消耗 20,000,001（越过旧默认 20M）后，下一轮仍派发；节点显示 `budget: null, unlimited: true`，无预算问题。
  2. 配置有限默认 1,000 时仍阻断（预算问题、`status: blocked`）；`setBudget null` 后问题关闭、节点恢复并派发。
  3. v13→v14 迁移保留存量实例 `budget=20,000,000, used=17, unlimited=0`。
  4. 不限实例遇到 `usage: null` 仍开 `unknown_usage` 问题并停止后续发送。
  5. 非法默认额度被拒绝。
  6. 真实 Chromium：任务页显示「不限」、不再显示旧的 20,000,000 总预算；节点详情显示「额度不限」与真实用量。
- 原始输出：`acceptance-evidence/unified-console/u01/verification.output.txt`。

## 边界与后续

- `limits.defaultBudgetTokens` 的图形化入口随 U05 配置向导提供；本轮已支持配置文件与 REST。
- 存量实例的批量转换目前通过 `setBudget` 逐节点完成；APP 级「存量策略」入口在 U10 汇入。
- PA01/PA02 未知用量、核对、activation 场景由既有 m8 套件在两轮全量中保持通过。

## 复现

```sh
cd /Users/macmini/workspace/graph-unified-dev
export PATH="$PWD/node_modules/.bin:$PATH"
./node_modules/.bin/tsc --noEmit && ./node_modules/.bin/tsc -p tsconfig.web.json --noEmit
./node_modules/.bin/vitest run tests/console/unlimited.test.ts tests/console/unlimited-ui.test.ts
./node_modules/.bin/vitest run
```
