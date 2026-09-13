# M7 MediaBookmarks 真实任务验收

> **2026-09-13 状态（待独立复验）：** R6 原权限绕过已关闭；S4/R8 已按第十二轮、R9/R10 已按第十三轮、R11/R12 已按第十四轮、R13（listen 回调注册顺序）已按第十五轮修复并本地复验：宿主按请求端口绑定、交付句柄并在检查 adopt 后释放，事件在宿主关闭后释放且 callback 保持 Node 注册位置，重复 ID 被拒绝；暂停拒绝与 `close()` 后监听器均为 0，固定端口、多次启停、并发、取消与事件驱动启动均正常。Graph 测试 38 文件 / 179 项；交付副本 `main` → `001f288a5a9fc797893497764d73bfe000bb198d`，a1–a5 全部有效，交付测试 40/40，独立审查 `docs/review-web-v3.md` 通过。是否关闭 S4/R8、R9/R10、R11/R12、R13 待独立复验；本仓库不自行宣布 Graph 整体完成。见 [R6 收尾验收](r6-acceptance-2026-09-13.md)、[IPC 监听返工验收](ipc-listener-acceptance-2026-09-13.md)、[adopted/ready 交接验收](ipc-handoff-acceptance-2026-09-13.md) 与 [验收证据](acceptance-evidence/README.md)。

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
| A13 | MediaBookmarks B站完整流程由 Graph 交付 | 机制回归见 `freeze.test.ts`、`delivery.test.ts`、`production.test.ts`、`page.test.ts`；2026-09-12 真实运行通过，见下 |

A01–A12 仍见 [M6 报告](m6-results.md)。两组验收均已通过。

## 真实 A13 运行（2026-09-12）

使用 commandcode 网关（实现 `deepseek/deepseek-v4-flash`，审查 `deepseek/deepseek-v4-pro`）在隔离副本上由 Graph 完成：

| 项 | 记录 |
| --- | --- |
| 任务 | `346cd2af-94e0-438d-aad6-4b2a9df925b2`，工作目录 `/Users/macmini/workspace/graph-m7-acceptance-7`（仓库外） |
| 提案 | 提案版本 1 由主管模型生成并经使用者确认；最终任务复用已确认内容，其历史从确认后的图开始 |
| 目标分支 | 隔离副本 `main` 快进到 `725cb1be6e005f45fdbe7000f6e0210fb47300bf`；实施提交 `4a4c2e2`（work，flash）、`725cb1b`（review，pro）；14 个文件，+1484/−14 行 |
| 验收 | a1–a5 五项在最终提交上全部有效：a1 为使用者人工登录确认，a2–a5 由 `graph.command` 在集成提交上跑交付测试（22/22 通过） |
| 独立审查 | 交付 `docs/review-bilibili-web-v1.md`：逐项核对通过，含质量观察与风险；审查用模型与实现模型不同 |
| 调用与用量 | 179 次 invocation、2,193,329 tokens（work 113 次 / 1,568,072；review 66 次 / 625,257；缓存输入占多数）；未配置费率，费用按规则保持 `unknown` |
| 时长 | 17.3 分钟（含人工登录确认） |
| 人工介入 | 仅：提供模型配置、确认提案、扫码登录并确认人工检查；未人工拆任务或转发上下文 |

真实数据验证（使用者确认前执行）：采集真实收藏 60 条 0 失败；笔记生成与导出出现真实“无字幕”失败原因并在汇总中显示。完整报告与证据保存在仓库外的 `/Users/macmini/workspace/graph-m7-acceptance-7/`；仓库不保存个人收藏数据、profile 与密钥。

真实运行暴露并修复的缺陷见 [后续计划](next-steps-after-r3.md#第八轮真实-a13-执行结果2026-09-12)：主管/审查缺少 schema 提示、Pi 会话预留过小、网关传输重置、worker 输出预算与 `run_command` 参数说明。

## Web 返工运行（2026-09-12）

独立验收判定 A13 缺少规定的本机 Web 应用后，Graph 修复 S1/R1/R2 并在已交付 CLI 的基础上重新运行（基线 `725cb1be` 的隔离克隆，工作目录 `/Users/macmini/workspace/graph-m7-acceptance-8`，均在仓库外）：

| 项 | 记录 |
| --- | --- |
| 任务 | `0e3c3c4d-52ed-48fe-935c-7d568be9679d` |
| 提案 | 版本 1 由 flash 主管生成、使用者确认；work-errors/work-web 用 flash，review 用 pro |
| 交付 | 隔离副本 `main` 到 `b1754facb338fef460b70caa5982c570c0ffad6b`；`6ca410f`（错误处理修复）、`3a21ff4`（Web 应用 + E2E 测试）、`b1754fa`（审查） |
| 验收 | a1–a4 在最终提交全部有效：a1 本机 Web 应用（`src/web/{server,page,main}.js`，复用既有 CLI 能力）、a2 非零业务码进入失败处理、a3 采集异常进入统一进度与汇总、a4 真实无头 Chromium E2E（异步进度、失败原因、笔记正文、Markdown 导出落盘） |
| 独立审查 | 交付 `docs/review-web-v2.md`：通过；审查模型与实现模型不同 |
| 调用与用量 | 487 次 invocation、10,422,914 tokens（flash 374 次 / 8,325,103，其中 1 次未记账；pro 113 次 / 2,097,811）；未配置费率，费用保持 `unknown` |
| 问题 | 1 次未知用量（网关连接重置）：宿主用显式 `reconcile_usage` 核对后继续，该调用仍记为 `unknown`/费用 unknown，未折算为零；审查 2,097,811 超预留 2,000,000，显式确认；人工检查由使用者完成 |
| 人工介入 | 提供模型配置、确认提案、执行 Web 五步闭环并确认人工检查 |

交付测试 38/38 通过（含真实无头 Chromium E2E）。其后第三轮小型任务（`graph-m7-acceptance-9`，任务 `834a5a88-c5f7-45a7-9b52-a6e0e95b0e4a`）修复了导出失败误报：`main` → `001f288a5a9fc797893497764d73bfe000bb198d`，新增 HTTP 500/网络拒绝真实页面回归，a1–a5 全部有效，交付测试 40/40，独立审查 `docs/review-web-v3.md` 通过；206 次 invocation / 3,481,777 tokens，work 超预留已显式确认。返工修复的提交与复验输出见 [后续计划第十轮](next-steps-after-r3.md#第十轮返工复验2026-09-12第二轮) 与 [验收证据](acceptance-evidence/README.md)。

## 本轮边界

未在使用者原仓库合入，未发布。未使用真实 B站登录、日常 Chrome 或真实收藏夹数据。未读取 `.env` / `.env.bm`，未调用收费模型。生产 Pi 在克隆上通过工作区工具写入 JavaScript 载荷，请求打到受控本地 chat-completions，不是收费编码模型。Graph 任务图里的 `human_check` 是合入前的登录确认；页面在采集前检查登录态并展示进度与笔记正文。目标项目保留原有 JavaScript/Python CLI，其他平台不接入本机 Web。

第三轮复验新增 `graph.command` 程序检查与真实模型验收 harness（`examples/m7-acceptance.ts`），使真实自主图不再依赖宿主预置的 `check` adapter；第四轮让 harness 以固定运行目录与 `run.json` 续跑同一任务：只接受 `GRAPH_M7_ACCEPT=<proposalVersion>` 确认当前提案、只回答 `GRAPH_M7_LOGIN_CONFIRMED=<questionId>` 指定的当前 open 人工问题，目标前移会把旧检查标为已替代并重新呈现，未配置费率时报告保留 `cost: unknown`。本地 provider 驱动的多进程回归见 `tests/m7/harness.test.ts`（确认前退出、错误确认被拒、登录等待、目标前移、旧确认不复用、重复重跑不重建任务）。第五轮起可用 `GRAPH_M7_RETRIEVAL_DOMAINS` 与 `GRAPH_M7_MCP_DOMAINS` 授予检索与远程 MCP 域名，并有 `accept:m7:contract` 对两个模型做少量真实契约请求后再进入任务。2026-09-12 的三次真实运行与 Web 返工均已完成，见上。
