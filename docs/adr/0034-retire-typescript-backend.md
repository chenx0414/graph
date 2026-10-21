# ADR 0034：退役 TypeScript 后端实现

2026-10-20。后端已由 Go 承担（ADR 0032、0033），仓库里仍并存一整套 TypeScript 后端实现与它的测试。本决策确定退役路径：**先用真实 E2E 把 Go 侧缺的契约补齐，再按活跃引用删除 TypeScript 实现**；删除不得削弱门禁。

状态：2026-10-21。下面「Go 侧仍缺的能力」里的两处已在退役批次 16 补齐并各有真实 E2E 证明——`provider.transport` 传输证据面（`tests/e2e/go-provider-reconciliation.test.ts`）与确定性的价格校验口子（`tests/e2e/go-price-snapshot.test.ts`）。批次 17 又把主实例的预算契约整份搬进 Go（`tests/e2e/go-main-budget.test.ts`），并钉住了预算闸门只在非全权访问下生效这一事实——TypeScript 与 Go 在这一点上同构。批次 18 搬进会话面的回合收尾契约（`tests/e2e/go-conversation-runtime.test.ts`），并修掉了 Go 侧一个真 bug：先推理再调工具的回合会把自己的思考块覆盖掉、整回合失败。批次 19 搬进自改进的沉淀契约（`tests/e2e/go-sediment-settings.test.ts`），并修掉了另一个真 bug：沉淀开关在活配置里永远读不到。批次 20 搬进图生命周期的节点配额契约（`tests/e2e/go-node-budget.test.ts`），走的是主 Agent 图工具那条会话面路径，并修掉了两个真 bug：一张图的两个节点并行开工时 daemon 会因并发写 map 当场退出，以及 provider 调用记录因结构体缺 JSON tag 而读不出状态与预留。批次 21 整份搬进图生命周期的节点队列契约（`tests/e2e/go-node-queue.test.ts`，4 条），并修掉了同族的第三个形状 bug：队列与执行历史的分页结构体没有 JSON tag，图上排着哪些活、一次执行用掉几次重试都读不出来。删除 TypeScript 实现本身尚未开始。

## 依据

- **两套实现已经漂移**。Go 侧 183 个文件约 80k 行，TypeScript 侧同构模块约 41k 行，两边各自演化。CI 的绿色主要由 TypeScript 实现背书，实际跑生产的是 Go，而 Go 侧只有少量 E2E——覆盖不对称，漂移抓不到。
- **没有任何一条产品行为是 Go 模型有意丢掉的**。逐条比对 35 个驱动 TypeScript daemon 的测试文件、176 条契约：`dropped-in-go` 数量为 0。空缺全部是「Go 侧还没有这条 E2E」、「这条证明写的是 TypeScript 内部实现」，或「Go 侧确实少一个能力」。
- **仓库政策要求先迁入真实 E2E 再退休旧测试**（`CODING_STANDARDS.md` 测试编写规则、`tests/AGENTS.md`、`.agents/skills/test-audit/SKILL.md`）。因此顺序不可颠倒：先补 Go keeper，再删 TypeScript 实现与其实现耦合测试。

## 退役边界：按活跃引用，而不是按目录

Go daemon 在运行时直接 spawn 六个 TypeScript 入口（`src/runtime/durable-service.ts` 等），它们承载崩溃恢复语义与图节点泳道，PiG 内核接管这两项之前不能删除。**从这六个入口出发的运行时闭包是 56 个 TypeScript 文件，必须保留**。

闭包必须同时按 **import 语句**与 **URL/路径字符串**两种引用计算：`src/runtime/durable-storage.ts` 用 `new Worker(new URL('./durable-storage-worker.ts', import.meta.url))` 拉起存储 worker，worker 再 import `durable-sqlite.ts`。只跟 import 会漏掉这两个文件，从而误判它们可删。

`src/server`、`src/core`、`src/runtime`、`src/catalog`、`src/git` 共 180 个文件的处置：

| 类别 | 数量 | 处置 |
| --- | --- | --- |
| Go 运行时闭包 | 56 | 保留，随 PiG 内核接管恢复语义后另行退役 |
| 仅前端可达 | 20 | 保留，属于浏览器侧契约 |
| 仅脚本/示例/桌面可达 | 100 | 本次删除目标，先迁移或退休这些工具 |
| 仅测试可达 | 4 | `src/server/cli.ts`（`pnpm start` 启动器）与 `src/server/go-launch.ts`（Go E2E 夹具依赖）保留 |

本次实际可删的是 **102 个模块**。

## 顺序

1. **补 Go E2E**：每条独立契约在 Go 上有一份真实 E2E（真实 `graphd` 进程 + 真实回环 HTTP + 受控 provider），证明它成立。
2. **退休 TypeScript 实现耦合测试**：证明写的是 TypeScript 内部实现（直接调用 `openTaskRuntime` / `TaskStore`、断言私有字段、手写私有表记录、注入假协作者）的测试随实现一起退役。
3. **迁移或退休 `scripts/`、`examples/` 里的 TypeScript 工具**：它们是 100 个待删模块的最后消费者。
4. **删除实现并更新门禁**：`package.json`、`tsconfig.json`、`tests/suite-baseline.json` 与文档同步落账。

## Go 侧仍缺的能力

删除 TypeScript 实现之前，Go 必须补上这两处，否则相关契约无法证明：

- **provider 传输证据**。TypeScript 侧每次 provider 尝试写一条 `provider.transport` 事件（`fetch_started` / `response_headers` / `transport_error`，带 `requestSha256`、`responseIds`、`usageRecoverableFromTransport`），并发送 `x-opencode-request-id` 关联头。Go 侧只有 `provider.request_profile`，证据面缺失。
- **确定性的价格校验口子**。`DaemonOptions.PriceVerify` 存在但 `serveDaemon` 从不设置，校验永远走归档 `sourceUrl` 的网络请求，真实 E2E 无法指向本地服务。

## 对既有决策的影响

不取代 ADR 0032 与 ADR 0033，只把「Go 拥有后端」从「实现选择」推进为「唯一实现」。ADR 0006 关于 TypeScript 作为领域内核实现语言的选择，其后端部分由本决策取代；Web 与桌面壳仍为 TypeScript，`src/web` 对 `src/core` 的投影依赖属于浏览器侧契约，不在本次删除范围。

## 计划与证据

[退役计划与覆盖矩阵](planning/ts-backend-retirement-2026-10-20.md) 记录模块清点、测试清点、逐文件覆盖矩阵、Go 侧缺口与每批交付。
