# Unified Console 返工报告（回应 2026-09-15 独立验收）

日期：2026-09-15。分支 `feat/unified-console`。返工基线 `2d06ef3`（被验收 SHA）。本轮不合并 `main`、不发布、不触碰其他工作区；所有验证使用受控本地供应商/临时仓库/真实 Chromium，无付费模型调用。

## 提交

| 批次 | 提交 | 范围 |
| --- | --- | --- |
| 1 | `93645d3` | UC-S01–S04、R04：Git 准入与受控基线 |
| 2 | `124a4ce` | UC-R01、R02、R08、R09、R10：热配置、连接身份与撤销 |
| 3 | `178dd8f` | UC-R05、R06、R07 与 U07–U09 部分剩余 |
| 4 | `ab669b0` | UC-R03 打包资源，价格币种手动覆盖、连接禁用入口 |

## 逐项修复与验证

### 批次 1：Git 边界（`src/git/git.ts`、`src/git/integration.ts`、`src/core/task-runtime.ts`）

- **S01**：`ready` 快照不再是永久授权。`requirePrepared` 每次边界（bind/accept/confirm/dispatch）用 `repoFingerprint`（HEAD、分支、含 index/worktree 的 porcelain 状态）与记录比对；旧快照过期即重新准备，脏仓库返回 `project_dirty`。验证器探针输出 `rejected:{...uncommitted changes...}`、`dispatched:false`。
- **S02**：基线改为显式文件清单（`baselineFiles`：`ls-files -co` 按项目范围，剔除真实 stateDir、`.env`、`*.sqlite*`、`node_modules` 等），用 `git add/commit --pathspec-from-file` 只提交清单内路径；用户已暂存的 `.env` 保持暂存不进入 HEAD。空仓库基线用 `commit-tree` 空树，避免误提交 index。
- **S03**：提交路径严格限定 `projectSubdir`；父仓库兄弟目录（含已暂存）不进入基线，用户 index 不变。验证器探针 `siblingCommitted:false`。
- **S04**：`projects.prepare` 不再在 SQLite 事务内执行 Git。先持久化 `git_ops` intent，事务外执行，成功后单独结算 receipt；启动时对 `intent` 记录做幂等重放。
- **R04**：通过 `rev-parse --absolute-git-dir/--git-common-dir` 定位排除文件，普通仓库、linked worktree 均可用。验证器探针 `worktreeBaseline` 返回新基线 SHA。
- 测试：`tests/console/git-baseline.test.ts`（5 项：stateDir/staged `.env` 排除、子目录范围、linked worktree、ready 后修改被拒、用户提交后重记录）。

### 批次 2：配置与连接（`live-config.ts`、`config-service.ts`、`start.ts`、`task-runtime.ts`、`setup.ts`、`desktop/main.mjs`、`Settings.tsx`）

- **R01**：项目集合改为每次从 live 读取；`host.syncProjects()` 注册热新增项目、守卫在途任务的根目录变更；`prepare()` 拒绝已移除项目。验证器探针 `hot-add-project` 通过，且 `projects.prepare` 同 PID 可用（本仓测试）。
- **R02**：候选先经 `live.check`（合并 env + APP 推送 + 撤销视图）批准，才写盘；拒绝时文件字节、保存/有效 revision、运行绑定都不变。验证器探针 `rejected-config-persisted-across-restart` 通过（`savedRevision:0`、`restartedConfigured:true`）。
- **R08**：配置模型增加 `modelId`（供应商身份），同名模型跨平台分配独立连接 id；Pi 传输使用 `modelId ?? id`；向导追加不覆盖；测试覆盖 A/B 两个真实本地供应商的 endpoint/请求体。
- **R09**：`pushSecret(ref,null)` 是显式撤销，写入 `<stateDir>/revoked-secrets.json`，重启后仍优先于 env；设置页增加「禁用连接」按钮走 APP 桥。验证器探针 `revoke-startup-env-secret` 通过。
- **R10**：`liveBudget()` 在 live 存在时不再用 `??` 回退有限启动值；`defaultBudgetTokens:null` 对新实例生效（不限），旧实例保持原状，有限↔不限双向可用。验证器探针 `finite-default-to-unlimited` 通过。
- 测试：`tests/console/config-edge.test.ts`（6 项，含两次守护进程重启与真实 provider 请求）。

### 批次 3：详情与统计（`node-run.ts`、`talent.ts`、`models.ts`、`task-runtime.ts`、Web UI）

- **R05**：分页契约明确为「无游标=最新尾页；`before` 向前；`after` 补断线间隙」；UI 首屏即最新记录，`载入更早记录` 可一路回到第一条，SSE 用 `after` 补齐。真实 Chromium 复验：单节点 501 条、双节点交错 1002 条，全部可达、无跨节点混入；`entry-full` 可展开超长正文。
- **R06**：默认统计与详情一致取最新版本；可显式选版本或「所有版本」，响应带 `scope` 标签；`tests/console/talent.test.ts` 手算 900/500/100。
- **R07**：费用按币种分桶（`sumCosts`/`mergeCosts`），节点、任务、会话、人才一律分币种展示，未知不折零、不再出现混合均值；人才统计含每币种样本/未知数。
- **U07–U09 部分剩余**：nodeRun 增加按定义版本冻结的能力绑定与安装状态、记录跨度/运行/凭据等待/其他等待的时间分段、容器子节点汇总、长正文按需展开；人才经历可载入更多并显示任务、模型与凭据等待。
- 验证器探针：分页 `beforeClick 200 → afterClick 300`、`latestVisible:true`、`foreignEntries:0`；统计 `defaultSampleVersions:["custom-observed@2"]`、`defaultTokenMean:900`、费用 `byCurrency` 分列（该探针的旧判据 `cost.mean===null` 与 R06「默认版本一致」修复后的单一币种语义冲突，详见下文）。

### 批次 4：打包（`scripts/package-app.mjs`）

- 打包复制清单与 electron-builder `files` 均加入 `presets/**`。布局验证（`acceptance-evidence/unified-console-rework/packaged-presets-fixed.mts`，正负对照）：新布局 `capabilities:5 / definitions:4 / missingPresetLog:false`，旧布局负对照 `0/0/true`，`PACKAGED_PRESETS_OK`。
- 验收方原探针 `packaged-presets.mts` 自行构造「仅复制 src」的旧布局，因此仍报 0/0；这是探针模拟的旧清单，不代表当前打包脚本。原始输出均存档。

## 统一验证（准确 SHA `ab669b0`）

- 主/Web `tsc` rc=0；`vite build` rc=0；全量 `vitest run`：**71 文件 / 343 项通过**（一次）。
- 8 个历史监听/沙箱探针 rc=0；主 Agent 入口 5 个探针（history/cache/millisecond/decision/boundaries）rc=0；app-console 两个端到端探针 rc=0。
- 验收方已修正判定的动态探针：`standards-git-boundaries` rc=0（S01 拒绝、S03 不提交兄弟、R04 worktree 基线）、`hot-boundaries` 3/3 通过、`config-edge-contracts` 3/3 通过。
- 原始输出：`acceptance-evidence/unified-console-rework/verification.output.txt`、`probes.output.txt`、`reviewer-probes/`、`packaged-presets-fixed.mts`。

## 未闭合与披露

- 验收方 `obs-node-pagination-statistics.mts` 的旧退出判据要求 `cost.mean===null`；R06 已把默认范围固定为最新版本，该场景范围内只有 CNY，按 R07 应给单一币种均值而非 null。分页与默认版本 token 均值均按其标准通过；多币种无混合均值由 `tests/console/talent.test.ts` 与 `allVersions` 场景覆盖。
- 价格模板仍无带日期的默认快照（不编造厂商价格），但设置页已有显式手动覆盖（含币种）且历史价格不重算；连接禁用/恢复正常经 APP 桥可用。
- 容器详情提供只读子节点汇总；容器内子图展开深度仍以图页为主。
- 真实付费供应商行为与真实模型对话质量、长会话摘要仍不在本轮。
- 真实 Electron 成品全流程尚未在本轮执行（仅窗口冒烟与打包布局验证）；该闭环列为下一批首要项。

## 复现

```sh
cd /Users/macmini/workspace/graph-unified-dev && export PATH="$PWD/node_modules/.bin:$PATH"
./node_modules/.bin/tsc --noEmit && ./node_modules/.bin/tsc -p tsconfig.web.json --noEmit
./node_modules/.bin/vite build && ./node_modules/.bin/vitest run
./node_modules/.bin/node docs/planning/acceptance-evidence/unified-console-rework/packaged-presets-fixed.mts "$PWD"
```
