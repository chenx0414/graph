# Graph 接手说明

快照：2026-09-13（Asia/Shanghai）。本文件描述产品化阶段（T01–T08 及 PA01–PA04 返工）后的工作区状态与入口；早期 R1–R4 的接手说明保留在下方作为历史。

**状态：监听与本地网络返工轮已由独立验收关闭（R13；见 [最终验收](r13-final-acceptance-2026-09-13.md)）。产品化待办 T01–T08 已实施，独立验收提出的 PA01–PA05 已按三轮返工修复并本地复验（含恢复时重取 Agent 名额、暂停拒绝不误报成功、保存期共享组冲突校验），报告与证据见 [产品化交付报告](productization-reports.md) 与各轮独立验收报告；等待独立复验，本仓库不自行宣布整体完成。Graph 全量 47 文件 / 218 项；交付副本 `main` → `001f288a5a9fc797893497764d73bfe000bb198d`，交付测试 40/40（含真实无头 Chromium E2E）。是否合入使用者原仓库、配置 remote 或发布由使用者决定。不要从 [M2 接手说明](m2-handoff.md) 恢复实施。**

该旧文件若仍出现在工作区，只是未提交的历史草稿（当时 M2 未完成）。当前真相以本文件、各 `mN-results.md`、[验收跟进](acceptance-followup.md) 和 `git log` 为准。

## 接手时先做

1. 工作区 `$REPO`，分支 `main`。运行 `git status --short` 应为空；`.gitignore`、`docs/planning/m2-handoff.md` 与 `next-steps-after-r3.md` 已按使用者要求入库。
2. 读取 [AGENTS.md](../../AGENTS.md)、[领域文档](../agents/domain.md)、[CONTEXT.md](../../CONTEXT.md)，再读 [产品规则](../graph-mvp.md)、[架构](../architecture.md)、[实施计划](../implementation-plan.md)。里程碑证据读对应 [mN-results](.)，不要凭本文件复述出口表。
3. 用项目 Node 24.20.0 复验。本机 PATH 上没有 `pnpm`（Node 与 tsc/vitest 都在 `node_modules/.bin`），因此用等价命令：
   ```sh
   cd $REPO
   export PATH="$PWD/node_modules/.bin:$PATH"
   node -v                                  # v24.20.0
   tsc --noEmit
   tsc -p tsconfig.web.json --noEmit
   vitest run                               # 47 files, 218 tests
   vite build
   git diff --check
   ```
   本机 PATH 上可能没有 `pnpm`；没有时用上面的等价命令，或先装 pnpm 再 `pnpm check`。启动与配置见 [使用文档](../usage.md)。
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
| 受限 worker 内扩展/网络检索/远程 MCP | 第五轮已关闭 | 见下方第五轮表 |

## 第五轮完成范围（2026-09-12）

原范围遗留的受限执行能力已补齐，均按定义版本加载并真实可调用：

| 项 | 状态 | 证据 |
| --- | --- | --- |
| 受限 worker 扩展加载 | 已关闭 | `src/runtime/extension-worker.mjs` 在受限 executor 内加载扩展最小 `register(api)` 接口；`tests/m3/capabilities.test.ts` 验证可调用、越权写入被拒、零用量计量 |
| 远程 MCP 域名白名单 | 已关闭 | `capability.json` `transport:http` + `network.mcpDomains`；未授予域名时节点以具体原因停止；`tests/m3/capabilities.test.ts` |
| 授权范围内网络检索 | 已关闭 | `src/runtime/retrieval.ts` 受控读取 broker；`fetch` 工具仅在有授予域名时暴露；`tests/m3/retrieval.test.ts` 覆盖允许与拒绝路径及暂停 |

## 准确边界

这些是已验证范围，不是待办：

- 机制矩阵 A01–A12 有可重复测试；A13 在 2026-09-12 的三轮真实运行中完成：CLI 交付（`725cb1be`）+ 本机 Web 应用（`b1754fac`）+ 导出失败反馈（`001f288`，交付测试 40/40 含真实无头 Chromium E2E，独立审查通过）。
- Skill、本地 stdio MCP、受限 worker 扩展与远程 MCP（运行时域名白名单）按定义版本加载并可调用；网络检索只放行授予域名、拒绝重定向与二进制、限制大小。扩展 worker 只实现本仓库定义的最小工具协议，官方 Pi 扩展 API 的完整语义、远程 MCP 的其他 transport 与其他平台仍未验证。
- `run_command` 与 `graph.command` 只允许 `node`（禁内联求值）与只读 `git`，都在 macOS 沙箱内运行；受限边界在每次派发前拒绝写授权内已存在的 `.git` 条目（命令与 MCP 共用），已确认验收检查项的 input 在修订中固定；其他平台未验证。
- 原项目 `$HOME/workspace/12-MediaBookmarks` 未被修改；真实运行在隔离副本 `$HOME/workspace/graph-m7-acceptance-7`（CLI）与 `-8`（Web 返工）完成，未把交付合入原仓库，未发布。
- 未读取 `.env`；真实模型费用未配置费率，报告按规则保持 `cost: unknown`；返工运行有 1 次网关连接重置未被供应商暴露用量，经宿主显式 `reconcile_usage` 继续，该调用仍记为 unknown，另有 1 次审查超额被显式确认——缺口均在报告中可见。真实运行确实使用了使用者的 B站 登录与真实收藏数据，但只写入隔离副本的 profile/raw/output，Graph 仓库不保存这些内容。

实施计划没有 M8。使用者已听到：下一步是其决定，不是自动开新包。

## 若使用者要求继续

只做其点名的那一项。完成后用公开入口证明，再两轴审查、再提交。

| 使用者可能说的话 | 要做的事 | 完成时可见 |
| --- | --- | --- |
| 用真实模型跑 M7 / 完成 A13 | 已于 2026-09-12 完成三轮（CLI + Web 返工 + 导出失败修复）；重新运行的方法、确认协议与真实记录见 [第八轮](next-steps-after-r3.md#第八轮真实-a13-执行结果2026-09-12)、[第九轮](next-steps-after-r3.md#第九轮最终验收返工2026-09-12) 与 [第十轮](next-steps-after-r3.md#第十轮返工复验2026-09-12第二轮) | 隔离副本 `graph-m7-acceptance-9`；`acceptance-report.json`、`run-summary.json`、`main` 提交 `001f288` |
| 合入原仓库 / 真用 B站 Web | 按使用者决定把交付的 `src/commands/bili-web.js`、`src/platforms/bilibili-web.js`、`src/progress.js`、`src/web/{server,page,main}.js`、`scripts/sha256.mjs`、`test/*.test.js`、`test/e2e/bilibili-web.e2e.test.js`、`src/cli.js`/`src/pipeline.js` 接线与两份审查报告合进 MediaBookmarks `main`；目标保持 JavaScript，登录走独立 `.browser-profile` | 原仓库有这些文件；`node --test test/*.test.js test/e2e/*.test.js` 38/38 通过；未提交 `.env` / profile / `output/` |
| 让扩展真正可加载 | 已在第五轮完成（见上）；若需官方 Pi 扩展 API 全量语义，另行评估受限 worker 的接口扩展 | — |
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
真实模型验收：`npm run accept:m7`（需要模型配置，见上）；调用授权契约预检：`npm run accept:m7:contract`。
真实 A13 记录（仓库外，含个人收藏数据）：`$HOME/workspace/graph-m7-acceptance-7/`。
