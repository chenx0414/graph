# TS 后端退役与 Go 覆盖补齐（2026-10-20）

## 目标

后端只保留 Go 一门实现语言。退役顺序固定为：先用真实 E2E 把 Go 侧缺的契约补齐，再按活跃引用删除 TypeScript 后端实现。删除不得削弱门禁——每条被删测试承载的独立契约，要么已有 Go E2E 证明，要么先补一条。

依据：[ADR 0032](../adr/0032-go-backend-shared-durable-host.md)（Go 拥有 HTTP/SSE、图状态、凭据、准入与用量）、[ADR 0033](../adr/0033-pig-go-kernel.md)（PiG 内核迁移）、[ADR 0034](../adr/0034-retire-typescript-backend.md)（退役路径与边界）。

工作分支：`feature/retire-ts-backend`（独立工作树 `/Users/macmini/workspace/13-Graph-ts-retire`）。

## 边界事实：Go 运行时仍然依赖一部分 TypeScript

`backend/internal/graph/` 在运行时直接 spawn TypeScript 入口，因此 `src/` 下的 TypeScript 不是全量死代码：

| Go 侧调用点 | 被 spawn 的 TS 入口 |
| --- | --- |
| `runtime_durable_client.go:62` | `src/runtime/durable-service.ts`（durable 侧车，承载恢复语义与图节点泳道） |
| `runtime_capabilities.go:1302` | `src/runtime/extension-worker.mjs` |
| `runtime_module_evaluator.go:175` | `src/runtime/module-worker.mjs` |
| `runtime_host_command.go:40` | `src/runtime/host-command-worker.mjs` |
| `runtime_workspace_command.go:79` | `src/runtime/check-resolver.cjs` |
| `runtime_durable_plugin.go` | `src/runtime/durable-plugin-worker.mjs` |

从这 6 个入口出发的**运行时闭包是 56 个 TypeScript 文件**（`src/runtime` 42、`src/core` 8、`src/catalog` 6）。这部分在 PiG 内核接管恢复语义与图节点泳道之前必须保留，见 [PiG 迁移计划](pig-go-kernel-migration-2026-10-20.md) 的「尚未完成」两项。

> 闭包必须同时按 **import 语句**和 **URL/路径字符串**两种引用计算：`src/runtime/durable-storage.ts` 用 `new Worker(new URL('./durable-storage-worker.ts', import.meta.url))` 拉起存储 worker，worker 再 import `durable-sqlite.ts`。只跟 import 会漏掉这两个文件，从而误判它们可删。

因此本次退役的准确含义是：**删除无运行时引用的 TypeScript 后端实现**，而不是清空 `src/`。

## 模块清点

`src/server`、`src/core`、`src/runtime`、`src/catalog`、`src/git` 合计 180 个文件，按可达入口分类：

| 类别 | 数量 | 处置 |
| --- | --- | --- |
| Go 运行时闭包 | 56 | 保留，PiG 迁移完成后随侧车一起退役 |
| 仅前端可达（`src/web` 打包依赖） | 20 | 保留，属于浏览器侧契约 |
| 仅脚本/示例/桌面可达 | 100 | 本次删除目标（先迁移或退休这些工具） |
| 仅测试可达 | 4 | `src/server/cli.ts`（`pnpm start` 启动器）与 `src/server/go-launch.ts`（Go E2E 夹具 `tests/helpers/cli-daemon.ts` 依赖它）保留；`src/runtime/prompt-options.ts`、`src/runtime/tool-call-target.ts` 随其测试一起处理 |

因此本次实际可删的 TypeScript 后端实现是 **100 + 2 = 102 个模块**，全部集中在「仅脚本/示例/桌面可达」这一类。

「仅脚本/示例/桌面可达」的 100 个文件就是 TypeScript 后端实现本体（`src/server/app.ts`、`src/server/start.ts`、`src/core/task-runtime.ts`、`src/core/kernel-store.ts`、`src/runtime/pi-adapter.ts` 等）。它们的最后消费者是 `scripts/` 与 `examples/` 下的工具：

- `scripts/branch-edge-e2e.mjs`、`scripts/harness-real-eval.mjs`、`scripts/harness-worker-eval.mjs`、`scripts/mcp-adapter-e2e.ts`、`scripts/console-ui-e2e.ts`、`scripts/interface-e2e.ts`、`scripts/state-reclaim.ts`、`scripts/create-review-module.ts`
- `examples/m1-demo.ts`、`examples/m7-acceptance.ts`、`examples/m7-contract.ts`、`examples/assemble-matt-team.ts`
- `src/git/integration.ts`（被 `examples/m7-acceptance.ts` 使用）

删除这 100 个文件之前，这些工具必须改为驱动 Go 进程或退役。

## 测试清点

全量基线（改动前，工作区含 PiG 迁移改动）：283 个文件、1553 个用例，1550 通过、3 跳过，174.93 秒。

| 类别 | 文件数 | 说明 |
| --- | --- | --- |
| 驱动 Go 进程（`launchCli`） | 17 | 已经是 Go 的 keeper |
| 驱动 TS daemon（`startGraphDaemon` / `createApp`） | 35 | 退役前必须有 Go 等价用例 |
| 依赖 TS 内部但不驱动 daemon | 206 | 实现耦合的低层测试，随实现一并退休；其中独立契约先迁入真实 E2E |
| 不依赖 TS 后端 | 42 | 前端与纯工具测试，不受影响 |

## 覆盖矩阵

Go 侧已有的 E2E（17 个文件）承担 keeper；下表登记 TS 侧契约与 Go 侧状态的对应关系，逐条补齐后再动实现。

### 逐文件结论（24 个驱动 TS daemon 的文件已完成比对）

| TS 文件 | 用例 | 已被 Go 覆盖 | 需新写 Go E2E | 实现耦合可退休 | 需 Go 先补功能 |
| --- | --- | --- | --- | --- | --- |
| `console/config-edge.test.ts` | 11 | 0 | 9 | 2 | 0 |
| `console/conversation-queue.test.ts` | 3 | 0 | 1 | 2 | 0 |
| `console/daemon-console.test.ts` | 1 | 0 | 0 | 1 | 0 |
| `console/hot-config.test.ts` | 7 | 1 | 6 | 0 | 0 |
| `console/price-snapshot.test.ts` | 5 | 0 | 1 | 3 | 1 |
| `console/pricing.test.ts` | 1 | 0 | 1 | 0 | 0 |
| `console/schema-upgrade.test.ts` | 4 | 0 | 4 | 0 | 0 |
| `console/setup-wizard.test.ts` | 1 | 0 | 1 | 0 | 0 |
| `e2e/browser-tool-loading.test.ts` | 1 | 0 | 1 | 0 | 0 |
| `e2e/catalog-tool-loading.test.ts` | 1 | 0 | 1 | 0 | 0 |
| `e2e/command-output-preservation.test.ts` | 2 | 0 | 2 | 0 | 0 |
| `e2e/graph-confirmation.test.ts` | 2 | 0 | 2 | 0 | 0 |
| `e2e/harness-cost.test.ts` | 10 | 0 | 10 | 0 | 0 |
| `e2e/pricing.test.ts` | 1 | 0 | 1 | 0 | 0 |
| `e2e/project-branches.test.ts` | 4 | 0 | 3 | 1 | 0 |
| `e2e/provider-metadata.test.ts` | 6 | 0 | 6 | 0 | 0 |
| `e2e/provider-reconciliation.test.ts` | 4 | 0 | 0 | 0 | 4 |
| `e2e/providers.test.ts` | 3 | 0 | 3 | 0 | 0 |
| `e2e/rework-runtime.test.ts` | 8 | 0 | 3 | 5 | 0 |
| `e2e/rsi-shape.test.ts` | 1 | 0 | 1 | 0 | 0 |
| `e2e/scoped-system-capabilities.test.ts` | 2 | 0 | 2 | 0 | 0 |
| `e2e/secret-lifecycle.test.ts` | 1 | 0 | 1 | 0 | 0 |
| `e2e/sediment-settings.test.ts` | 1 | 0 | 1 | 0 | 0 |
| `e2e/thinking.test.ts` | 1 | 0 | 1 | 0 | 0 |
| `m2/matt-team.test.ts` | 3 | 0 | 1 | 0 | 2 |
| `m3/production.test.ts` | 11 | 0 | 11 | 0 | 0 |
| `m5/graph.test.ts` | 4 | 0 | 4 | 0 | 0 |
| `m5/http.test.ts` | 6 | 2 | 4 | 0 | 0 |
| `m8/app-shell-ux.test.ts` | 32 | 0 | 32 | 0 | 0 |
| `m8/credentials.test.ts` | 5 | 0 | 5 | 0 | 0 |
| `m8/provider-headers.test.ts` | 4 | 0 | 4 | 0 | 0 |
| `m8/recipe-compile.test.ts` | 9 | 0 | 7 | 2 | 0 |
| `m8/settings-ui.test.ts` | 10 | 0 | 10 | 0 | 0 |
| `m8/startup.test.ts` | 10 | 2 | 8 | 0 | 0 |
| `m8/tool-failure-record.test.ts` | 1 | 0 | 1 | 0 | 0 |
| **小计** | **176** | **5** | **149** | **16** | **7** |

结论：**没有任何一条产品行为是 Go 模型有意丢掉的**（`dropped-in-go` 数量为 0）。所有空缺要么是「Go 侧还没有这条 E2E」，要么是「这条证明写的是 TS 内部实现」，要么是「Go 侧确实少一个能力」。

### Go 侧确实缺的两个能力

1. **provider 传输证据不存在**。TypeScript 后端每次 provider 尝试都写一条 `provider.transport` 事件（`phase` 为 `fetch_started` / `response_headers` / `transport_error`，带 `requestSha256`、`responseIds`、`usageRecoverableFromTransport`；`src/runtime/pi-adapter.ts:1033`），并且发送 `x-opencode-request-id` 关联头。Go 侧只有 `provider.request_profile`（`backend/internal/graph/runtime_pi_adapter.go:1700`），没有 `provider.transport`、没有关联头。**行为**（传输失败记为未知用量、不静默重发、`reconcile_usage` 收敛）在 Go 里存在，**证据**不存在。`tests/e2e/provider-reconciliation.test.ts` 的 4 条契约因此无法移植——这 4 条要等 Go 补出证据面。
2. **没有确定性的价格校验口子**。`DaemonOptions.PriceVerify` 存在（`backend/internal/graph/server_start.go:31`），但 `serveDaemon` 从不设置它（`backend/internal/graph/server_cli.go:353-356`），校验永远是 `defaultPriceVerify`——去拉归档里的 `sourceUrl`，测试无法指向本地服务。因此「校验成功会抬高版本号并被下一次调用冻结」这一条暂时无法写成真实 E2E。
3. **Matt 团队装配没有可达入口**。`backend/internal/graph/catalog_matt_team.go:40` 的 `AssembleMattTeam` 是个零调用方的库，`server_cli.go` 没有对应 flag，HTTP 路由表里也没有装配入口。TypeScript 侧有 `src/catalog/matt-team.ts` + `examples/assemble-matt-team.ts`。`tests/m2/matt-team.test.ts` 的两条装配契约因此无法端到端证明——要么给 Go 补一个入口，要么把 `examples/assemble-matt-team.ts` 连同其契约一起退役（这是产品决定，不是代码能定的）。
4. **编译失败没有可触发的真实输入**。Go 的 `SavedAgentCombination.CompileError` 由 `recover` 产生（`catalog_catalog.go:176-189`），但 TypeScript 侧那条测试是用 `vi.spyOn` 注入失败的（违反 E2E 规则：不能 mock 自有协作者）。要证明「编译失败时保留配方、不发布定义、报告错误」，需要一个真实能通过校验但编译不过的输入；目前没有找到自然触发点。
5. **两处提示词文本断言不能照搬**。`tests/m3/production.test.ts` 断言的是 TypeScript 的原文（`src/runtime/agent-context.ts`），Go 的公共/主规则文本不同（`backend/internal/graph/runtime_agent_context.go:88,89`），照搬会失败。Go 的用例必须断言 Go 自己的规则文本。
6. **提示词隔离契约在 Go 侧未验证**。TypeScript 用例断言工作节点的提示词不含其他节点的私有指引（`UNRELATED-PROTOCOL-`、`OTHER_NODE_PRIVATE_GUIDANCE`）；Go 的提示词装配在 `catalog_briefing.go` + `core_node_prompt.go`，没有找到显式的排除步骤。这条要靠一次真实的 Go 回合来确认是否仍然成立。

### 移植时的已知陷阱

- **Go 的图布局不是纯 Go**：`backend/internal/graph/server_layout.go:317-357` 会 shell out 到 `node` + `elkjs`。几何类契约的 E2E 必须在 `node_modules/elkjs` 在场的环境里跑——这是最高风险的移植点。
- **`DELETE` 的空 JSON body 400 是 Fastify 的产物**：`tests/m8/recipe-compile.test.ts:211-214` 断言 `DELETE` 带 `content-type: application/json` → 400、不带 → 200，Go 的 `net/http` 没有这条规则。Go 的用例要断言 Go 真实的删除语义，而不是照抄这个框架产物。
- **浏览器用例里的 mock 必须换成真实后端**：`tests/m8/app-shell-ux.test.ts` 有八条用例用 `page.route` 伪造应用自己的 `/api/conversations` 响应，还有两条注入了假的 `actions.master`。按仓库规则（只可替代外部服务，不能 mock 自有协作者），这些 fixture 不是有效 keeper——契约保留，证明方式换成真实 Go 进程 + 受控 provider。

### 已补的 Go E2E

| TS 契约来源 | Go 侧文件 | 用例 |
| --- | --- | --- |
| `tests/m5/http.test.ts` 任务面：创建、列举、读回、事件游标重连、命令通道鉴权 | `tests/e2e/go-task-http.test.ts` | 3 |
| `tests/m5/http.test.ts` 会话创建时应用模型与思考档位 | `tests/e2e/go-conversation-http.test.ts` | 2 |
| `tests/m5/http.test.ts` APP 桥接密钥生命周期 | `tests/e2e/go-app-bridge.test.ts` | 3 |
| `console/config-edge.test.ts` 热配置生效、被拒候选不落盘、撤销跨重启、损坏撤销文件 fail-closed、双凭据撤销 | `tests/e2e/go-hot-config.test.ts` | 5 |
| `tests/m5/http.test.ts` 暂停/恢复：暂停期间的消息不外发，恢复后放行，暂停跨重启保持 | `tests/e2e/go-pause-resume.test.ts` | 2 |
| `console/conversation-queue.test.ts` 队列消息取消：可撤回、同一请求不重复撤回、不存在的消息报 missing | `tests/e2e/go-conversation-queue.test.ts` | 2 |
| `e2e/rework-runtime.test.ts` 项目被移出配置后历史保留、拒绝新任务 | `tests/e2e/go-removed-project.test.ts` | 1 |

## 执行批次

每批结束都要求 `node --run check` 全绿，并显式更新 `tests/suite-baseline.json`（`node --run check:baseline` 是门禁，缩减用例必须显式落账，不允许靠改基线掩盖失败）。

- **Batch 1（已完成）**：Go 任务面 HTTP 契约。`tests/e2e/go-task-http.test.ts`——真实 `graphd` 进程、真实回环 HTTP、真实状态目录；证明任务可创建/列举/读回、事件游标可断点重连、命令通道对匿名与跨源调用关闭。
- **Batch 2（已完成）**：会话创建的模型与思考档位。`tests/e2e/go-conversation-http.test.ts`——证明用户选的模型与思考档位落在会话上，并且真正到达该模型指向的 provider。
- **Batch 3（已完成）**：桌面 APP 桥接的密钥生命周期。`tests/e2e/go-app-bridge.test.ts`——证明推送的密钥生效、密文不落配置文件、撤销留下持久记录、无令牌被拒。
- **Batch 4（已完成）**：运行中 daemon 的配置语义。`tests/e2e/go-hot-config.test.ts`——证明热保存后新项目立即可用、被拒候选不落盘且 daemon 保持原配置、撤销跨重启仍然生效、损坏的撤销文件 fail-closed、两个凭据的撤销都被记录。
- **Batch 5（已完成）**：暂停与恢复。`tests/e2e/go-pause-resume.test.ts`——证明暂停期间到达的消息不会到达 provider、恢复后放行、暂停是任务的事实因而跨重启保持。
- **Batch 6（已完成）**：队列消息的撤回。`tests/e2e/go-conversation-queue.test.ts`——证明排队中的消息可以撤回、同一请求不重复撤回、不存在的消息报 missing 而不是被编造。
- **Batch 7（已完成）**：项目移出配置。`tests/e2e/go-removed-project.test.ts`——证明历史仍然可读、项目从控制台消失、新任务被明确拒绝而不是被静默接受。
- **Batch 8（下一步）**：APP 桥接 RSI 重启队列（`tests/m5/http.test.ts`）。
- **Batch 9（下一步）**：图布局几何契约（`tests/m5/graph.test.ts`）——Go 的布局走 node+elkjs，风险最高，尽早证明。
- **Batch 10 起**：按覆盖矩阵逐文件移植，每个文件一个 keeper。
- **收尾**：迁移或退休 `scripts/`、`examples/` 里的 TS 工具，删除 100+4 个模块，更新 `package.json`、`tsconfig.json`、门禁与文档。

## 门禁与纪律

- 只允许新增或改写真正的 E2E：真实浏览器、HTTP、CLI 或公开运行时，真实持久化与副作用。禁止单元/集成测试。
- Go E2E 的夹具是 `tests/helpers/cli-daemon.ts` 的 `launchCli`（真实 `graphd` 二进制）与 `tests/fixtures/openai-server.ts`（受控模型服务）。自有协作者的回执、顺序与状态必须由真实 owner 产生。
- 退役旧测试前先证明新 keeper 通过；负向断言先证明目标元素、请求或 guard 存在。
- 每次提交前运行 `node --run check`。
