# Graph 接手说明

快照：2026-09-12（Asia/Shanghai）。使用者要求把本轮 R1–R4 修复整理成 handoff，供其他 Agent 接手。

**状态：首版实施计划 M0–M7 已提交；独立验收反例的早期修复见 [acceptance-rework.md](acceptance-rework.md)，第三位 Agent 的 R1–R4 复验见 [acceptance-followup.md](acceptance-followup.md#第三位-agent-的复验结果2026-09-12)，第四轮 S1 与两项 Spec P1 修复见 [next-steps-after-r3.md](next-steps-after-r3.md#第四轮修复结果2026-09-12)。最近一次功能修复提交见该节末尾；其后的 docs 提交只记录哈希。不要从 [M2 接手说明](m2-handoff.md) 恢复实施。**

该旧文件若仍出现在工作区，只是未提交的历史草稿（当时 M2 未完成）。当前真相以本文件、各 `mN-results.md`、[验收跟进](acceptance-followup.md) 和 `git log` 为准。

## 接手时先做

1. 工作区 `/Users/macmini/workspace/13-Graph`，分支 `main`。运行 `git status --short`：允许残留 `M .gitignore`（只多了 `.agents/`）、未跟踪的 `docs/planning/m2-handoff.md` 与 `docs/planning/next-steps-after-r3.md`。前三项按使用者约定不要并进产品提交；`next-steps-after-r3.md` 是第四轮审查输入，已在其中追加修复结果。
2. 读取 [AGENTS.md](../../AGENTS.md)、[领域文档](../agents/domain.md)、[CONTEXT.md](../../CONTEXT.md)，再读 [产品规则](../graph-mvp.md)、[架构](../architecture.md)、[实施计划](../implementation-plan.md)。里程碑证据读对应 [mN-results](.)，不要凭本文件复述出口表。
3. 用项目 Node 24.20.0 复验。本机 PATH 上没有 `pnpm`（Node 与 tsc/vitest 都在 `node_modules/.bin`），因此用等价命令：
   ```sh
   cd /Users/macmini/workspace/13-Graph
   export PATH="$PWD/node_modules/.bin:$PATH"
   node -v                                  # v24.20.0
   tsc --noEmit
   tsc -p tsconfig.web.json --noEmit
   vitest run                               # 35 files, 145 tests
   vite build
   git diff --check
   ```
   `npm run check` 会因为缺少 `pnpm` 而失败；需要时先装 pnpm 或用上面的等价命令。通过标准见 [验收跟进](acceptance-followup.md)。
4. 未指定下一步之前，不要开新里程碑、不要改 MediaBookmarks 原仓库、不要读 `.env`、不要调用收费模型。

## 本轮完成范围（R1–R4）

| 项 | 状态 | 证据 |
| --- | --- | --- |
| R1 文件工具符号链接越界 | 已关闭 | `src/runtime/bounded-path.ts`；`tests/m3/agent-tools.test.ts`；`symlink-boundary.mts` 拒绝且外部文件不存在 |
| R2 补充需求未传给主管模型 | 已关闭 | `src/catalog/briefing.ts` 渲染 `User messages`；`tests/m3/production.test.ts`；`followup-message.mts` 为 true |
| R3 定义绑定能力未加载 | 已关闭（限定范围） | `src/runtime/capabilities.ts`、`mcp-client.ts`、`workspace-command.ts`；`tests/m3/capabilities.test.ts`、`workspace-command.test.ts`、`tests/m4/command-check.test.ts`；扩展仍拒绝在后台加载 |
| R4 真实自主任务验收 | 机制补齐，真实运行待使用者介入 | `graph.command`；`examples/m7-acceptance.ts`（`npm run accept:m7`）；**A13 不标通过** |

本轮没有可用真实模型与真实 B站 登录，因此未执行 A13 的真实运行；所需用户步骤写在 [验收跟进 R4](acceptance-followup.md#r4--spec-p1--机制已补齐真实运行待使用者介入)。

## 第四轮完成范围（2026-09-12）

第四轮 [审查](next-steps-after-r3.md) 的 S1 与两项 Spec P1 已修复：

| 项 | 状态 | 证据 |
| --- | --- | --- |
| S1 命令/MCP 可写 Git 元数据 | 已关闭 | `restricted-process.ts` 在每次派发前扫描并拒绝写授权内已存在的 `.git` 条目（相对/嵌套/绝对/硬链接均覆盖）；只读 Git 改以具体 CLT 二进制运行；`tests/m3/workspace-command.test.ts`、`tests/m3/capabilities.test.ts`；`command-git-boundary.mts` 输出 `protected:true` |
| Spec P1 修订可削弱验收命令 | 已关闭 | `revision.ts` 固定已确认检查项的 input；`tests/m4/command-check.test.ts`；`command-input-revision.mts` 输出 `revisionRejected:true` 且无有效证据 |
| Spec P1 真实验收入口不可靠续跑 | 已关闭 | `examples/m7-acceptance.ts` 固定运行目录 + `run.json`，只确认当前提案版本与当前 open 问题，目标前移重新呈现；`tests/m7/harness.test.ts` 多进程覆盖；未配置费率时保留 `cost: unknown` |
| 受限 worker 内扩展/网络检索/远程 MCP | 仍未实现 | 绑定扩展仍以具体原因阻塞；报告不列为能力已实现 |

## 准确边界

这些是已验证范围，不是待办：

- 机制矩阵 A01–A12 有可重复测试。A13 的 scripted 与生产 Pi 机制测试保留；真实模型运行未执行，不标完成。
- Skill 与本地 stdio MCP 按定义版本加载；MCP 每次调用一个受限进程并经 send gate。远程 MCP 域名白名单、扩展在受限 worker 内加载、网络检索入口仍未实现。
- `run_command` 与 `graph.command` 只允许 `node`（禁内联求值）与只读 `git`，都在 macOS 沙箱内运行；受限边界在每次派发前拒绝写授权内已存在的 `.git` 条目（命令与 MCP 共用），已确认验收检查项的 input 在修订中固定；其他平台未验证。
- 原项目 `/Users/macmini/workspace/12-MediaBookmarks` 未被修改，未把 Web 合入原仓库，未发布。
- 未读取 `.env`，未调用收费模型，未使用真实 B站 登录或真实收藏数据。
- 生产 Pi 在克隆上写 JavaScript 载荷时使用受控本地 chat-completions，不是收费编码模型。

实施计划没有 M8。使用者已听到：下一步是其决定，不是自动开新包。

## 若使用者要求继续

只做其点名的那一项。完成后用公开入口证明，再两轴审查、再提交。

| 使用者可能说的话 | 要做的事 | 完成时可见 |
| --- | --- | --- |
| 用真实模型跑 M7 / 完成 A13 | 按 `examples/m7-acceptance.ts` 配置模型（两个不同模型 ID）：先运行看提案，再用 `GRAPH_M7_ACCEPT=<proposalVersion>` 确认该准确版本；每次登录检查用其打印的 `GRAPH_M7_LOGIN_CONFIRMED=<questionId>`；真实登录走 CLI + 独立 profile。目标前移会重新呈现检查 | `acceptance-report.json`、目标分支合并提交、真实 invocation 记录；A13 才可标通过 |
| 合入原仓库 / 真用 B站 Web | 把克隆上的 `src/web-server.js`、`src/web/index.html`、`test/web-server.test.js` 与 `package.json` 的 `web` 脚本合进 MediaBookmarks `main`。目标保持 JavaScript。登录仍走独立 `.browser-profile` 的 CLI | 原仓库有这些文件；`GRAPH_FIXTURE=1 node --test test/web-server.test.js` 通过；未改 Graph 的 TS 约束；未提交 `.env` / profile / `output/` |
| 让扩展真正可加载 | 在受限 worker 内加载扩展并保持调用计量与暂停；不得在后台进程直接加载第三方扩展代码 | 绑定扩展的定义可运行；越权与凭据测试仍通过；更新 ADR 0008 与该范围报告 |
| 指定 GitHub 仓库 | 按 [issue-tracker](../agents/issue-tracker.md) 设 remote；需要时再发 G01–G18 的 Issue | `git remote -v` 有目标；未另起一套任务平台 |

其他平台 Web、把 Graph 标成「已发布」都要使用者先说。返工循环不必在 MediaBookmarks 任务上再演示一遍，机制证据在 M4。

## 必须保持的执行习惯

- 对使用者用中文；代码注释与 commit 用英文。约定式提交：`feat:` / `fix:` / `test:` / `docs:`。
- Node 24 strip-only TypeScript，`exactOptionalPropertyTypes`。改完跑相关 `tests/mN`，结束前跑完整套件。
- 先写会失败的公开行为测试再实现。Git 调用走 `src/git/git.ts`（隔离 pager/gpg/hooks，stdin ignore），避免 vitest 挂起。
- 实例副本分支是 `graph/copy/<taskId>/<nodeId>`，集成分支是 `graph/task/<taskId>`。确认需求后不要再 `say`，否则提案会因需求版本过期被拒。
- 文件工具边界走 `src/runtime/bounded-path.ts`；能力加载与受限进程见 `capabilities.ts`、`restricted-process.ts`、`workspace-command.ts`。
- 提交前用 `code-review` 对固定点做 Standards / Spec 两轴审查。产品范围以 `docs/graph-mvp.md` 为准。
- 工作副本外的 MediaBookmarks、真实 profile、真实收藏不是可无条件共享的并发资源。

## 本机验证命令

分里程碑：`vitest run tests/m7` 或 package.json 里的 `test:m0` … `test:m7`。
公开入口诊断：`docs/planning/acceptance-evidence/README.md`（10 个 `node *.mts`，浏览器场景先 `vite build`）。
真实模型验收：`npm run accept:m7`（需要模型配置，见上）。
