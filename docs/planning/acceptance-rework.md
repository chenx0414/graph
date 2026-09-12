# M2–M7 验收复验

日期：2026-09-12。对应 [独立验收](acceptance-m2-m7.md) 中的 P1/P2 反例。基线仍为 M1 `19511f7`；本轮在 `d0193bb` 之后修复并回归。

没有读取 `.env`、没有调用收费模型、没有改写 MediaBookmarks 原仓库。原验收诊断程序仍只打印观察值；通过与否以 Vitest 回归为准。

## 检查

使用项目 Node `v24.20.0`：

| 检查 | 结果 |
| --- | --- |
| `./node_modules/.bin/tsc --noEmit` | 通过 |
| `./node_modules/.bin/tsc -p tsconfig.web.json --noEmit` | 通过（已启用 `allowImportingTsExtensions`；`pnpm check` 包含该配置） |
| `./node_modules/.bin/vitest run` | 30 个文件、123 项测试通过 |
| `./node_modules/.bin/vite build` | 通过 |
| `git diff --check` | 通过 |

## 反例与回归

公开入口仍是 Task Runtime、HTTP、真实临时 SQLite/Git、本地 provider 与 Playwright。

| 编号 | 修复 | 回归 |
| --- | --- | --- |
| ST-01 | Git 重检跳过仍有 `unknown_usage`/`budget`/`permission` 锁定的实例 | `tests/m4/acceptance.test.ts` 用量未知后晚到集成不再二次派发审查 |
| ST-02 / SP-08 | 枚举 worktree，在目标实际检出位置检查干净并快进 | 同文件：另一 worktree 检出 `main` 且脏时打开 `git_dirty`，不裸更新 |
| SP-01 | 生产 Pi 注入工作区工具、主管 `propose_graph`/`revise_graph`、能力安装；讨论期 `say` 唤醒主管 | `tests/m3/production.test.ts` |
| SP-02 | 每次 provider 发送前检查暂停、未知用量与额度 | 同文件：缺 usage / 超额后第二次 HTTP 不发出 |
| SP-03 | Git 合入要求程序拥有的独立审查门（`graph.verify` + reviewer 定义），不把 Agent JSON 的 `verdict` 当通过；无审查图不能合入 | `tests/m4/acceptance.test.ts`、`tests/m4/merge.test.ts` |
| SP-04 | 图修订冻结确认验收的检查动作、verifier 与必要依赖 | `tests/m2/revision.test.ts` |
| SP-05 | 审查排除穿过程序节点取实现模型 | `tests/m4/acceptance.test.ts` |
| SP-06 | 人工确认绑定当前 activation 与集成提交 | 同文件 |
| SP-07 | 评委只在无合格候选时否决 | `tests/m2/verification.test.ts` |
| SP-09 | Web 按问题类型提交有效答复；额度表单为 `add_budget` | `tests/m5/ui.test.ts` |
| SP-10 | 图页订阅 SSE 并刷新节点状态 | 同文件 |
| SP-11 / G18 | 保留 scripted 编排测试；另用生产 Pi 工具在克隆上写入 B站 Web 并审查合入。本地 chat-completions 仍是受控模型，不是收费编码 | `tests/m7/delivery.test.ts`、`tests/m7/production.test.ts` |
| SP-12 / SP-13 | 采集前检查登录；直播采集异步进度；笔记可读 | `tests/m7/page.test.ts`、`tests/fixtures/m7/web-server.test.js` |

## 里程碑

| 里程碑 | 本轮 |
| --- | --- |
| M2 | 验收语义不可削弱；评委保留合格胜者 |
| M3 | 生产 Pi 有工作工具与主管通道；逐请求预算/未知用量生效 |
| M4 | 独立审查门、目标 worktree、人工确认绑定、未知用量重检 |
| M5 | 额度答复与图状态可从浏览器走通；前端类型检查纳入 `pnpm check` |
| M6 | 原故障注入在新审查门下仍通过 |
| M7 | 页面登录/进度/笔记可运行；scripted 全图编排保留；生产路径在克隆上写入并合入 |

收费供应商上的自主编码、原仓库合入、真实 B站登录仍不在本轮范围。使用者决定发布。
