# Unified Console 第三轮返工报告（回应 2026-09-15 第二轮独立验收）

日期：2026-09-15。分支 `feat/unified-console`。返工基线 `73bc1d0`。本轮不合并、不发布、不触碰其他工作区；全部验证使用临时 Git、合成数据与受控本地协议，无付费模型调用。

## 提交

`dd89228`：UC-S04-R2、R08-R2、R09-R2、R12-R1、R13-R1 五项修复与回归测试。

## 逐项修复

### UC-S04-R2 · 非 Git 目录恢复提交未确认内容

- 新增 `directoryFingerprint(root,{stateDir})`：对普通目录按相对路径+内容哈希（排除 stateDir/敏感文件，5000 文件上限）；`GitIntegration.projectFingerprint` 在非仓库时返回该指纹而不是 `null`。
- 恢复逻辑因此不再可能用 `null == null` 证明未变化：旧式无指纹 intent 或内容已变 → `unresolved` + `project_preparation.failed`，不会 `git init`、不会提交。未变化的请求仍可幂等重放。
- 回归：`tests/console/git-recovery.test.ts` 新增「非 Git 目录、intent 无指纹、文件被改 → unresolved 且无 .git」；探针 `plain-directory-crash-before-init` 通过（`state:unresolved`）。

### UC-R08-R2 · 热改配置改写历史审查身份

- 身份冻结改为事实来源：`Execution` 在选型绑定时把底层身份（`modelId ?? id`）写入 `instances.models_used`，脚本/本地 adapter 也生效；`implementerModels` 优先读取调用记录（`invocations.model` = 派发时的 wire id，`task-gate` 写入），无调用再回退到 `models_used`，两者都不再用当前 live 目录重新解释。
- 回归：探针 `historical-model-identity-after-config-change` 通过（热改 `writer.modelId` 后 `reviewRuns:0`）；静态别名与多 endpoint 场景保持通过。

### UC-R09-R2 · 并发撤销丢失一个引用

- `start.ts` 增加配置/密钥串行队列：`applyConfig` 与 `pushSecret` 的**完整**「读取当前撤销集合 → 校验 → 原子持久化 → 激活/回滚」在同一队列内执行，不再出现两次读改写互相覆盖。
- 回归：`tests/console/config-edge.test.ts`「并发撤销两个连接」断言两引用均落盘、重启后 `enabledModelCount:0`；探针 `concurrent-revocations` 通过（`enabledAfterRestart:0`）。

### UC-R12-R1 · 未授权远程 MCP 显示可执行

- `loadCapabilities` 的远程分支按实际工具授权计算报告：无匹配 grant → `executable:false` 并给出所需 grant 示例；部分授权给出数量与原因；本地能力维持可执行，只读讨论远程跳过逻辑不变。权限门本身未改。
- 回归：探针 `capability-grant-facts` 通过（无 grant 失败、匹配 grant 正对照成功）。

### UC-R13-R1 · 已成功节点因历史 not_sent 显示进行中

- 所有 `not_sent`/`interrupted` 终止路径写入 `settled_at`（恢复前未派发、reconcile not_started、adapter 失败、暂停预发送、gate 拒绝）；
- `nodeRun.timing` 改为生命周期判定：终态节点永不 `inProgress`；总历时=已结算尝试的首次派发到末次结算；运行=已结算尝试之和；暂停/等待用户仍如实「未记录」。
- 回归：`tests/console/node-run.test.ts` 新增「succeeded 节点含历史 not_sent 尝试 → inProgress:false、totalMs:1000」；探针 `settled-node-timing` 通过。

## 统一验证（准确 SHA `dd89228`）

- 主/Web `tsc` rc=0；`vite build` rc=0；全量 `vitest run`：**356 项通过**（72 文件）。
- 验收方全部动态探针真实 rc=0（10/10）：本轮新增 `remaining-boundaries`、`capability-grant-facts`、`settled-node-timing`；上轮 7 个 `git-rework-edge-cases`、`config-new-boundaries`、`config-edge-contracts`、`hot-boundaries`、`obs-ui-statistics`、`obs-capability-timing`、`packaging-current-manifest` 复跑仍全通过。
- 关键字段：`plain-directory-crash-before-init state:unresolved`；`concurrent-revocations enabledAfterRestart:0`；`historical-model-identity reviewRuns:0`；`capability-grant-facts` 无授权拒绝/授权正对照；`settled-node-timing inProgress:false`。
- 8 个历史沙箱/监听探针 rc=0；主 Agent 入口 5 探针 rc=0。
- 原始输出：`docs/planning/acceptance-evidence/unified-console-rework3/`。

## 未闭合（保持原计划状态）

- 成品 Electron 全链路与旧 schema 升级；带日期来源的默认价格快照与刷新流程。
- 暂停/等待用户的时间分段仍未按状态边界落账（本轮保证未知不冒充活跃、不补造数值）；与 R13 同批的完整体验需后续补齐。
- 长会话摘要、真实供应商与对话质量评估维持原状态。

## 复现

```sh
cd /Users/macmini/workspace/graph-unified-dev && export PATH="$PWD/node_modules/.bin:$PATH"
./node_modules/.bin/tsc --noEmit && ./node_modules/.bin/tsc -p tsconfig.web.json --noEmit
./node_modules/.bin/vite build && ./node_modules/.bin/vitest run
```
