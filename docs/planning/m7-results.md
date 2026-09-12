# M7 MediaBookmarks 真实任务验收

日期：2026-09-12。对应 [实施计划 G17–G18](../implementation-plan.md#m7-mediabookmarks-真实任务验收) 与验收矩阵 A13。基于 M6 的提交 `b1ec02c`。本轮在 Graph 内讨论并冻结 B站本机 Web 验收，并在 MediaBookmarks 的 git 克隆上拆解、分配工作副本、实现、检查、独立审查、记录人工登录项并合入目标分支。scripted 工人覆盖全图编排；生产 Pi 经工作区工具写入同一载荷。页面含登录准入、异步采集进度与笔记阅读。不调用收费模型。

## 可运行结果

```sh
pnpm test:m7
pnpm check
```

完整套件见 [验收复验](acceptance-rework.md)：30 个文件、123 项测试。不读取项目 `.env`，不调用收费模型，不改写使用者原 MediaBookmarks 仓库。

## 通过范围

| 项 | 值 |
| --- | --- |
| 平台 | Darwin arm64（macOS） |
| Node | 24.20.0（项目 `devEngines` / `node_modules/.bin/node`） |
| 包管理 | pnpm 11.19.0，`pnpm-lock.yaml` 锁定 |
| 命令 | `pnpm typecheck`、`pnpm test`、`pnpm test:m7` |
| 输入项目 | `/Users/macmini/workspace/12-MediaBookmarks` 于 `1bed8f4` |
| 交付目标 | 该仓库的 git 克隆，`main` |
| 执行 | scripted 全图编排 + 生产 Pi 工作区工具；程序检查跑 `node --test`；`GRAPH_FIXTURE=1` 合成数据 |

改实现后应重跑 `pnpm test:m7`，再跑 `pnpm check` 做回归。不以截图代替交付证明。发布仍由使用者决定，本轮只合入克隆的目标分支。

## G17

| 出口 | 证据 |
| --- | --- |
| 在 Graph 内冻结验收 | `tests/m7/freeze.test.ts`：`say` 后主管提案，`view().proposal` 含登录态、采集进度与失败原因、收藏与笔记、Markdown 导出、人工登录 |
| 明确界面、测试数据、登录步骤 | 用户 `say` 固定本机页面、`GRAPH_FIXTURE`、CLI + 独立 profile；提案摘要重复资源约定 |
| 目标分支 | 确认时 `targetBranch: 'main'` |
| 不把 Graph TS 强加给目标 | 交付为 JavaScript + `node:http` + `node:test`；克隆无 `tsconfig.json` |
| 资源不可无条件共享 | 独立 profile、禁止并发采集、不复用日常 Chrome；克隆不含 `.browser-profile`、`output/`、真实 `raw/` |

## G18

| 出口 | 证据 |
| --- | --- |
| 主管拆解并交接 | 讨论期主管提案；工人 `briefing` 含验收项，测试不由用户复制上下文 |
| 独立工作副本 | `web-api` 与 `web-ui` 并行写入不同 worktree，再汇入集成分支 |
| 实现 / 检查 / 独立审查 | 工人写入 `src/web-server.js`、`src/web/index.html`、`test/web-server.test.js`；`check` 跑 `node --test`；`reviewer@1` 写入 `docs/bilibili-web-review.md` |
| 人工登录项 | `graph.human_check` 在 acknowledge 前保持 `running`；测试中的确认代表规定的介入，不是真实打开 B站 |
| 合入目标分支 | 克隆 `main` 含 Web、测试、审查结论；原仓库 HEAD 与工作区状态不变 |
| 用量记录 | 各 Agent 实例 `used > 0`；本轮无 Pi invocation，不产生供应商费用 |
| 返工 | 本任务一次通过，未进入返工；回环机制仍以 M4 为准 |

用户操作仅为：提出需求、确认提案、确认人工登录项。未人工拆任务或转发上下文。

## 验收矩阵 A13

| 编号 | 行为 | 本轮证据 |
| --- | --- | --- |
| A13 | MediaBookmarks B站完整流程由 Graph 交付 | `freeze.test.ts` 冻结验收；`delivery.test.ts` scripted 全图；`production.test.ts` 生产 Pi 写入；`page.test.ts` 登录/进度/笔记 |

A01–A12 仍见 [M6 报告](m6-results.md)。两组验收现均有可运行证据。

## 本轮边界

未在使用者原仓库合入，未发布。未使用真实 B站登录、日常 Chrome 或真实收藏夹数据。未读取 `.env` / `.env.bm`，未调用收费模型。生产 Pi 在克隆上通过工作区工具写入 JavaScript 载荷，请求打到受控本地 chat-completions，不是收费编码模型。Graph 任务图里的 `human_check` 是合入前的登录确认；页面在采集前检查登录态并展示进度与笔记正文。目标项目保留原有 JavaScript/Python CLI，其他平台不接入本机 Web。
