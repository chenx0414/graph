# Unified Console 第二轮返工报告（回应 2026-09-15 独立验收）

日期：2026-09-15。分支 `feat/unified-console`。返工基线 `7ff648a`。本轮不合并 `main`、不发布、不触碰其他工作区；全部验证使用临时 Git、合成数据与受控本地路径，无付费模型调用。

## 提交

| 批次 | 提交 | 范围 |
| --- | --- | --- |
| 1 | `06d0f55` | UC-S02-R1、S03-R1、S04-R1：Git 树快照、范围与崩溃恢复 |
| 2 | `121f0c9` | UC-R02-R1、R08-R1、R09-R1：候选预检、底层模型身份、撤销持久化 |
| 3 | `17c6346` | UC-R05-R1、R07-R1、R11–R13：分页突发、实体隔离、多币种、能力与时间投影 |

## 逐项修复

### Git（`src/git/git.ts`、`src/git/integration.ts`、`src/core/task-runtime.ts`）

- **S02-R1**：环境凭据改为一致策略——所有 `.env` 变体（含 `.env.production`、子目录、已暂存）一律排除，只保留明确文档白名单（`.env.example/.sample/.template/.dist/.defaults`），并把白名单写入 `.git/info/exclude` 的否定行，避免 ignore 反向拦截文档示例。探针 `sensitiveCommitted:false`。
- **S03-R1**：基线候选改为「从父树出发的范围变更集」（add/modify/delete/rename，经 `--porcelain=v1 -z` 解析），提交用 path-limited `commit --pathspec-from-file`：删除子目录最后文件不再生成空树，兄弟目录始终保留在 HEAD；无变更时不移动 HEAD，只有真正空仓库才建 root 提交；用户 index 不被清空。探针 `siblingStillCommitted:true`、`subdirLastDeletion/subdirPartialDeletion` 通过。
- **S04-R1**：prepare intent 记录 `headBefore` 与内容级 `fingerprintBefore`（含工作区 blob 哈希）。恢复时先核查：HEAD 已推进且为我方 `graph: local baseline` 提交（message+parent 匹配）→ 恢复原收据、**不再执行 Git**，重启后的新修改不会进入基线；HEAD 未动且指纹一致 → 可安全重放；否则标记 `unresolved` 并写 `project_preparation.failed`，等待显式重新准备。探针 `crashReplay` 重启前后提交数一致（2→2）、HEAD 内容保持「explicitly approved baseline」、后续修改保持未提交。
- 测试：`tests/console/git-baseline.test.ts`（7 项）、`tests/console/git-recovery.test.ts`（3 项：commit 后/commit 前+变更/commit 前+未变）。

### 配置（`src/server/start.ts`、`src/core/task-runtime.ts`、`src/catalog/models.ts`、`src/core/execution.ts`）

- **R02-R1**：候选批准回调增加 `host.checkProjects`（只读）——活跃项目（discussing/running/queued）改根目录在写盘与激活前拒绝；`syncProjects` 复用同一检查。探针 `active-project-root-rejection`：文件字节不变、可见集合与账本 root 一致、revision 不变。
- **R08-R1**：新增 `modelIdentity(entry)=modelId ?? id`；审查排除改用底层身份，历史 `models_used` 配置 id 经当前目录或持久化 `models` 快照映射为身份。真实 runtime 探针中 `writer`/`writer-alias` 同上游模型时审查节点不会被派发到同身份；测试覆盖别名不可越过、不同模型可选。
- **R09-R1**：撤销持久化改为原子写（临时文件 + rename），失败时返回 `applied:false` 并保持原绑定，绝不虚假成功；启动时撤销文件不可读/损坏改为**失败关闭**（所有已配置凭据先按撤销处理并记录日志），不会静默重新启用 key，显式重新保存即可修复。测试覆盖写失败、重启、损坏文件与连续禁用；探针 `revoke-persistence-failure` 通过。

### 投影（`src/core/node-run.ts`、`src/core/store.ts`、`src/web/NodeDetail.tsx`、`src/core/talent.ts`）

- **R05-R1**：`NodeDetail` 刷新改为有界逐页前推（每页 200，最多 60 页 until `hasNewer=false`），一次 SSE 合并即可把 >200/400 的突发补齐，不依赖后续事件；初始页仍为最新尾页。真实 Chromium：双节点各 761 条，突发后 `beforeClick=761`、`latestVisible:true`。
- **R11**：图内嵌入式面板加实体 key，`NodeDetail` 内部加 scope + generation 双守卫，切换节点时清空游标，迟到响应按代际丢弃，`loadOlder` 同样核验。真实 Chromium：A→B 首屏 200 尾部、迟到 A 响应注入 B 面板 0 条。
- **R07-R1**：人才样本先保存完整「币种→金额」映射，再做每币种统计；同一实例跨模型/币种返工不增加经历数。探针与测试：单实例 CNY 10 + USD 20 → 两桶各均值 10/20、`mixedCurrency:true`、样本数 1。
- **R12**：新增 schema v18 `node_capabilities`，`loadCapabilities` 返回真实加载报告（技能只读加载、本地能力、远程只读讨论不加载及原因），pi-adapter 在准备阶段写入；`nodeRun` 只用最近一次真实记录投影；无记录显示「未记录/未加载」，不再由 catalog installed 猜测；远程 MCP 只读讨论这一契约性跳过可由任务状态权威推导。探针 `capability.passed:true`（`禁用 / 只读讨论模式不加载远程能力`）。
- **R13**：总历时=首次派发到最后结算（operation 时间戳），运行/凭据等待来自实际记录；暂停与等待用户未写账时显示「未记录」，不再用消息跨度补造。探针 `totalMs:1000`、`pauseMs:null`、`userWaitMs:null`。
- 迁移顺序按版本号排列（v14→v18）；`tests/console/unlimited.test.ts` 的 v13 回退同步回收新表。

## 统一验证（准确 SHA `17c6346`）

- 主/Web `tsc` rc=0；`vite build` rc=0；全量 `vitest run`：**72 文件 / 353 项通过**。
- 验收方本轮全部动态探针真实 rc=0：`git-rework-edge-cases`、`config-new-boundaries`、`config-edge-contracts`、`hot-boundaries`、`obs-ui-statistics`、`obs-capability-timing`、`packaging-current-manifest`。
- 关键场景字段：`sensitiveCommitted:false`、`siblingStillCommitted:true`、`crashReplay 2→2`；`active-project-root-rejection` 文件未变；`revoke-persistence-failure` 通过；`burst 761/761`、`graphSwitch bCount:200`、`lateResponse bPanelContainsA:0`；能力与时间投影通过。
- 8 个历史沙箱/监听探针 rc=0；主 Agent 入口 5 个探针 rc=0。
- 原始输出：`acceptance-evidence/unified-console-rework2/`（探针、历史探针、verification）。

## 未闭合（按验收要求继续保留）

- **成品 Electron 全流程**：仍只有窗口冒烟与打包布局对照；干净打包 APP 的凭据桥、热配置、对话→Git→确认→review→人才经历全链路（含旧 schema 升级）尚未执行。
- **带日期与来源的默认价格快照/更新流程**：手动价格与币种覆盖、历史价格不重算已具备；模板默认价格仍无经核实的快照，未编造。
- 容器入口、正文展开、人才经历分页已实现但未纳入成品 APP 路径验证。

## 复现

```sh
cd /Users/macmini/workspace/graph-unified-dev && export PATH="$PWD/node_modules/.bin:$PATH"
./node_modules/.bin/tsc --noEmit && ./node_modules/.bin/tsc -p tsconfig.web.json --noEmit
./node_modules/.bin/vite build && ./node_modules/.bin/vitest run
```
