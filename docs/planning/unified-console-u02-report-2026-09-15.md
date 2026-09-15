# U02 项目 Git 准入与初始化：实施与验证报告

日期：2026-09-15。分支 `feat/unified-console`。契约见 [ADR 0010](../adr/0010-unified-console-contracts.md)。前置 `2d9a331`（U01）。

## 交付内容

- **schema v15**（`src/core/store.ts`）：新增 `project_preparation(project_id PRIMARY KEY, state, repo_root, project_subdir, branch, baseline_sha, detail, updated_at)`。状态为 `detected | initializing | ready | failed`。
- **宿主准备**（`src/git/integration.ts`、`src/git/git.ts`）：
  - 普通目录：`git init -b main` + 受控基线提交，幂等；空目录产生空基线提交；不配置 remote、不改全局 Git 配置、不 push。
  - 已有仓库：识别真实 repo root 与项目子目录；无 HEAD 时补基线；干净且有 HEAD 时直接 `ready`（不新增提交）；脏仓库记为 `detected` 并报告未提交数量，不自动提交或 reset。
  - 显式 `createBaseline: true` 才会把当前可见改动提交为本地基线，并记录范围与样例。
  - 本地排除写入 `.git/info/exclude`（不修改用户文件、不提交）：`.env`、`.env.*`、`secrets.json`、`node_modules/`、`state/`、`dist/`、`coverage/`、`.stage/`、`graph.config.json`；基线提交不包含这些路径，文件仍留在磁盘。
  - 项目是仓库子目录时保留范围：记录 `repo_subdir`，worker 与 `graph.command` 在 worktree 的子目录内启动，不创建嵌套仓库。
  - 修复 `repoRoot` 的负缓存：只有成功的仓库检测才被缓存，初始化后立即生效。
- **执行准入**：
  - `user.task().accept`、会话 `confirm` 在任何正式状态写入前调用 `requireTargetBranch`（准备 + 目标分支存在性），失败返回 `project_dirty` / `invalid_input`，不产生已接受任务。
  - 会话 `bind` 要求项目 Git-ready：普通目录自动初始化，脏仓库以 `project_dirty` 明确阻断。
  - 直接调用 Runtime/REST 与 APP 走同一条路径，无静默无 Git 回落。
  - `prepareTask` 不再在无仓库时静默返回；worktree 与集成分支按既有流程创建。
  - 交付审查沿用既有 M4 规则：有代码变更的集成提交必须通过独立审查后才合入目标分支；当集成分支与目标完全一致（无代码变更）时无需审查即可完成，验收检查仍必须通过。
- **API/UI**：`GET /api/projects/:id/preparation`、`POST /api/projects/:id/prepare`（幂等 requestId）；`runtime.projects.prepare/preparation`；`/api/settings` 的项目列表带 preparation 状态；设置页新增「项目 Git 准备」卡片（状态、基线与子目录、脏改动数量、准备/创建基线按钮）。

## 测试适配说明

新规则改变了隔离与交付语义，以下既有套件按同一含义更新，不放宽断言：

- 写文件后读取项目根路径的用例改为读取对应 worktree（worker 副本或集成副本）：m3 capabilities、workspace-command、production、m8 conversation-readonly、rework（partial 读取 operation workspace）。
- 需要完成交付的用例补上既有独立审查夹具：m8 ui-flow（并预建 `feature-a` 分支）。
- m4 merge 的脏目标用例改为在验收后制造脏改动（此前会在验收前被准入阻断）；m4 command-check 的宿主依赖目录移入被排除的 state 目录。
- m8 records-ui 的「尚无集成提交」断言更新为「集成提交」：验收现在总会创建集成分支。
- U01 迁移用例回退到真正的 v13 形态（同时移除 v15 表）。

## 验证

- `tsc --noEmit`、`tsc -p tsconfig.web.json --noEmit`、`vite build`：rc=0。
- `vitest run`：**60 → 61 文件 / 301 项通过**（新增 `tests/console/git-admission.test.ts` 9 项）。
- 新增用例覆盖：普通目录/空目录初始化与幂等、敏感与生成文件不入基线、干净仓库零提交、脏仓库阻断与显式基线、无 HEAD 仓库补基线、仓库子目录范围、直连 Runtime 无回落、未知目标分支验收前失败且项目未动。
- 原始输出：`acceptance-evidence/unified-console/u02/verification.output.txt`。

## 边界与后续

- 基线范围选择为「全部可见文件减宿主排除」；未提供逐文件勾选，页面说明影响（U10 可再细化）。
- 远端交互（clone/remote/push）不在范围；无 remote 环境可完成本地全流程。
- 配置向导中的 Git 准备入口随 U05；本轮已提供设置页卡片与 REST。

## 复现

```sh
cd /Users/macmini/workspace/graph-unified-dev
export PATH="$PWD/node_modules/.bin:$PATH"
./node_modules/.bin/vitest run tests/console/git-admission.test.ts
./node_modules/.bin/vitest run
```
