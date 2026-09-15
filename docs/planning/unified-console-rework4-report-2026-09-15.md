# Unified Console 第四轮返工报告（回应 2026-09-15 第三轮独立验收：R08-R3）

日期：2026-09-15。分支 `feat/unified-console`。返工基线 `a0f7c84`。不合并、不发布、不触碰其他工作区；验证使用本地 OpenAI 夹具/脚本数据，无付费模型调用。

## 提交

`b642ad6`：UC-R08-R3 修复与回归测试（另含 docs 提交）。

## 根因与修复

生产 Pi 路径把 `ModelEntry.id`（连接 ID）写入 `invocations.model`：`taskGate(..., entry)` 收到的是配置条目，不是 `toPiModel` 后的 wire 模型；而 `implementerModels` 一旦有 invocation 就只用该列并提前返回，丢弃了选型时已冻结在 `instances.models_used` 的底层身份 `modelId ?? id`，于是 exclude 只有连接 ID，审查仍可用同一底层模型。

修复两层：

1. `src/runtime/task-gate.ts`：派发时写入 `model.modelId ?? model.id`，invocation 自此保存底层上游身份（无 `modelId` 的旧式条目回退为连接 ID，仍可用）。
2. `src/core/execution.ts`：`implementerModels` 改为**并集**——invocation 记录 ∪ `instances.models_used` 冻结身份，二者都不再对当前 live 目录重新解释；任一路径缺失都不会丢掉已用底层模型。

`selectModel` 现有的「同时匹配 `modelIdentity` 与 `id`」逻辑保持不变，配置别名与多 endpoint 仍受同一身份约束。

## 验证（准确 SHA `b642ad6` / 文档 `…`）

- 主/Web `tsc` rc=0；`vite build` rc=0；全量 `vitest run`：**72 文件 / 357 项通过**。
- 新增回归：`tests/console/config-edge.test.ts`「provider invocations freeze the upstream identity」——带 `modelId` 的条目派发后 `invocations.model='original-model'`，无 `modelId` 旧条目回退自身 id。
- 验收方组合探针 `combination-remaining.mts` 真实 rc=0：
  - `production-static-same-upstream`：`providerRequests:1`、`reviewStatus:blocked`；
  - `production-hot-change-writer-modelId`：`providerRequests:1`、`reviewStatus:blocked`；
  - `partial-mcp-grants`、`plain-directory-unchanged-replays` 保持通过。
- 全部 11 个验收方探针 rc=0（本轮组合 1 + 上轮 3 + 更早 7）；8 个历史探针 rc=0；主 Agent 入口 5 探针 rc=0。
- 原始输出：`docs/planning/acceptance-evidence/unified-console-rework4/`。

## 未闭合（保持原计划状态）

- 成品 Electron 全链路与旧 schema 升级。
- 带日期、来源的默认价格快照/刷新流程。
- 暂停/等待用户时间分段仍待落账（当前如实「未记录」，不补造）。
- 长会话摘要、真实供应商与对话质量评估维持原状态。

## 复现

```sh
cd /Users/macmini/workspace/graph-unified-dev && export PATH="$PWD/node_modules/.bin:$PATH"
./node_modules/.bin/tsc --noEmit && ./node_modules/.bin/tsc -p tsconfig.web.json --noEmit
./node_modules/.bin/vite build && ./node_modules/.bin/vitest run
```
