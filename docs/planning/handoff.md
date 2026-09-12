# Graph 接手说明

快照：2026-09-12 09:49（Asia/Shanghai）。使用者要求把本轮工作整理成 handoff，供其他 Agent 接手。

**状态：首版实施计划 M0–M7（G01–G18）已在 `main` 提交。没有未完成的里程碑代码。不要从 [M2 接手说明](m2-handoff.md) 恢复实施。**

该旧文件若仍出现在工作区，只是未提交的历史草稿（当时 M2 未完成）。当前真相以本文件、各 `mN-results.md` 和 `git log` 为准。

## 接手时先做

1. 工作区 `/Users/macmini/workspace/13-Graph`，分支 `main`，HEAD `751e5da`（`feat: deliver MediaBookmarks Bilibili web through Graph`）。运行 `git status --short`：允许残留 `M .gitignore`（只多了 `.agents/`）和未跟踪的 `docs/planning/m2-handoff.md`。这两项按使用者约定不要并进产品提交，除非使用者明确要求。
2. 读取 [AGENTS.md](../../AGENTS.md)、[领域文档](../agents/domain.md)、[CONTEXT.md](../../CONTEXT.md)，再读 [产品规则](../graph-mvp.md)、[架构](../architecture.md)、[实施计划](../implementation-plan.md)。里程碑证据读对应 [mN-results](.)，不要凭本文件复述出口表。
3. 用项目 Node 24.20.0 复验：`export PATH="$PWD/node_modules/.bin:$PATH"` 后 `node -v` 应为 `v24.20.0`，再 `tsc --noEmit` 与 `vitest run`。宿主 PATH 上的 Node 可能是 26，`pnpm` 可能不在 PATH。通过标准：26 个测试文件、107 项测试，`git diff --check` 干净。
4. 未指定下一步之前，不要开新里程碑、不要改 MediaBookmarks 原仓库、不要读 `.env`、不要调用收费模型。

## 本轮完成的提交

本工作区从 M2 未完成草稿接到首版计划结束。提交都在 `main`：

| 提交 | 里程碑 | 报告 |
| --- | --- | --- |
| `ab03c98` | M0 | [m0-results.md](m0-results.md) |
| `19511f7` | M1 | [m1-results.md](m1-results.md) |
| `5766bb5` | M2 G06–G08 | [m2-results.md](m2-results.md) |
| `fed519f` | M3 G09–G11 | [m3-results.md](m3-results.md) |
| `2da2765` | M4 G12–G13 | [m4-results.md](m4-results.md) |
| `989d8c5` | M5 G14–G15 | [m5-results.md](m5-results.md) |
| `b1ec02c` | M6 G16 A01–A12 | [m6-results.md](m6-results.md) |
| `751e5da` | M7 G17–G18 A13 | [m7-results.md](m7-results.md) |

测试入口约定见 [tests/README.md](../../tests/README.md)：Task Runtime / HTTP inject / Playwright；真实磁盘 SQLite 与 Git；scripted 外部动作。不 mock 内核，不查私有表证明行为。

## 准确边界

这些是已验证范围，不是待办：

- 机制矩阵 A01–A12 有可重复测试。A13 是 Graph 对 MediaBookmarks **git 克隆** 的交付：scripted 工人写入 `tests/fixtures/m7/` 中的 JS 载荷，检查跑 `GRAPH_FIXTURE=1` 的 `node --test`，人工登录是 `graph.human_check` 的 acknowledge。
- 原项目 `/Users/macmini/workspace/12-MediaBookmarks` 仍停在 `1bed8f4`。克隆不含 `node_modules`、`output/`、`raw/`、`.env`、`.browser-profile`。
- 未把 Web 合入原仓库，未发布。未真实打开 B站，未使用日常 Chrome 或真实收藏。未配置 GitHub remote，Issues 仍只写在实施计划里。
- 生产 Pi adapter 在 M3 已接通；本轮 M7 工人不是收费模型自主编码。页面登录态在采集之前检查；Graph 图里的 `human_check` 是合入前的登录确认。

实施计划没有 M8。使用者已听到：下一步是其决定，不是自动开新包。

## 若使用者要求继续

只做其点名的那一项。完成后用公开入口证明，再两轴审查、再提交。

| 使用者可能说的话 | 要做的事 | 完成时可见 |
| --- | --- | --- |
| 合入原仓库 / 真用 B站 Web | 把克隆上的 `src/web-server.js`、`src/web/index.html`、`test/web-server.test.js` 与 `package.json` 的 `web` 脚本合进 MediaBookmarks `main`。目标保持 JavaScript。登录仍走独立 `.browser-profile` 的 CLI。 | 原仓库有这些文件；`GRAPH_FIXTURE=1 node --test test/web-server.test.js` 通过；未改 Graph 的 TS 约束；未提交 `.env` / profile / `output/` |
| 接真实模型 | 按 M3 契约注入运行配置中的模型，不把 key 写入文档或前端。用生产 Agent 再跑同类任务。 | invocation 落到真实供应商；审查模型避开该轮实现模型；仍不把密钥写进仓库 |
| 指定 GitHub 仓库 | 按 [issue-tracker](../agents/issue-tracker.md) 设 remote；需要时再发 G01–G18 的 Issue | `git remote -v` 有目标；未另起一套任务平台 |

其他平台 Web、把 Graph 标成「已发布」都要使用者先说。返工循环不必在 MediaBookmarks 任务上再演示一遍，机制证据在 M4。

## 必须保持的执行习惯

- 对使用者用中文；代码注释与 commit 用英文。约定式提交：`feat:` / `fix:` / `test:` / `docs:`。
- Node 24 strip-only TypeScript，`exactOptionalPropertyTypes`。改完跑相关 `tests/mN`，结束前跑完整套件。
- 先写会失败的公开行为测试再实现。Git 调用走 `src/git/git.ts`（隔离 pager/gpg/hooks，stdin ignore），避免 vitest 挂起。
- 实例副本分支是 `graph/copy/<taskId>/<nodeId>`，集成分支是 `graph/task/<taskId>`。确认需求后不要再 `say`，否则提案会因需求版本过期被拒。
- 提交前用 `code-review` 对固定点做 Standards / Spec 两轴审查。产品范围以 `docs/graph-mvp.md` 为准。
- 工作副本外的 MediaBookmarks、真实 profile、真实收藏不是可无条件共享的并发资源。

## 本机验证命令

```sh
cd /Users/macmini/workspace/13-Graph
export PATH="$PWD/node_modules/.bin:$PATH"
node -v          # v24.20.0
tsc --noEmit
vitest run       # 26 files, 107 tests
git diff --check
```

分里程碑：`vitest run tests/m7` 或 package.json 里的 `test:m0` … `test:m7`。
