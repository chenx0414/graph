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

`src/server`、`src/core`、`src/runtime`、`src/catalog`、`src/git` 合计 **179 个 TypeScript 模块**（另有 `src/catalog/models-dev.snapshot.json` 一个数据文件，Go 侧运行时直接读它，保留），按可达入口分类：

| 类别 | 数量 | 处置 |
| --- | --- | --- |
| Go 运行时闭包 | 56 | 保留，PiG 迁移完成后随侧车一起退役 |
| 仅前端可达（`src/web` 打包依赖） | 19 | 保留，属于浏览器侧契约 |
| 启动器 | 2 | `src/server/cli.ts`（`pnpm start` 启动器）与 `src/server/go-launch.ts`（Go E2E 夹具 `tests/helpers/cli-daemon.ts` 依赖它）保留 |
| 本次删除 | 102 | `src/server` 16、`src/core` 43、`src/runtime` 35、`src/catalog` 6、`src/git` 2 |

因此本次实际可删的 TypeScript 后端实现是 **102 个模块**。批次 54 已经把它们删掉，删完之后 `src/` 下只剩：两个启动器、Go 运行时闭包（56 个）、仅前端可达的 19 个文件，以及 `src/web`。

「仅脚本/示例/桌面可达」的那 102 个文件就是 TypeScript 后端实现本体（`src/server/app.ts`、`src/server/start.ts`、`src/core/task-runtime.ts`、`src/core/kernel-store.ts`、`src/runtime/pi-adapter.ts` 等）。它们的最后消费者是 `scripts/` 与 `examples/` 下的工具：

- `scripts/branch-edge-e2e.mjs`、`scripts/harness-real-eval.mjs`、`scripts/harness-worker-eval.mjs`、`scripts/mcp-adapter-e2e.ts`、`scripts/console-ui-e2e.ts`、`scripts/interface-e2e.ts`、`scripts/create-review-module.ts`（`scripts/state-reclaim.ts` **已退休**：能力搬进 `graphd reclaim`）
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

### 低层 206 个文件的处置规则

低层测试全部**按驱动方式**耦合 TypeScript 实现：它们直接开 `openTaskRuntime` / `TaskStore` / durable 传输 / `catalog.*` 助手，而不是走公开面。因此：

- **判定标准是「这份证明是否依赖将被删除的实现」**，不是「断言看起来像不像业务规则」。一份文件即使写着预算、用量、准入、验收，只要它开的是 TypeScript 运行时对象、断言的是私有字段或私有表记录，它就是实现耦合的证明，随实现一起退休。
- **独立契约的迁移单位是「契约」，不是「文件」**。低层文件里出现的业务规则（预算、未知用量的阻塞、只写自己的 worktree、恢复后不重复投递……）必须在 Go 上重新被证明一次——这是**新写一条 Go E2E**，不是把 TS 测试改个驱动。
- **风险集中在「只存在于低层、没有别处证明」的规则**。已派出的有界审计正在逐条核对这部分（45 个业务规则最密集的文件 × 35 文件矩阵 × 现有 Go E2E）。
- 机械的标题匹配在这件事上没有用（产生 334 条误报），所以这一步必须按语义读代码。

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
| `console/setup-wizard.test.ts` | 1 | 1 | 0 | 0 | 0 |
| `e2e/browser-tool-loading.test.ts` | 1 | 0 | 1 | 0 | 0 |
| `e2e/catalog-tool-loading.test.ts` | 1 | 0 | 1 | 0 | 0 |
| `e2e/command-output-preservation.test.ts` | 2 | 0 | 2 | 0 | 0 |
| `e2e/graph-confirmation.test.ts` | 2 | 0 | 2 | 0 | 0 |
| `e2e/harness-cost.test.ts` | 10 | 0 | 10 | 0 | 0 |
| `e2e/pricing.test.ts` | 1 | 0 | 1 | 0 | 0 |
| `e2e/project-branches.test.ts` | 4 | 0 | 3 | 1 | 0 |
| `e2e/provider-metadata.test.ts` | 6 | 6 | 0 | 0 | 0 |
| `e2e/provider-reconciliation.test.ts` | 4 | 0 | 0 | 0 | 4 |
| `e2e/providers.test.ts` | 3 | 0 | 3 | 0 | 0 |
| `e2e/rework-runtime.test.ts` | 8 | 0 | 3 | 5 | 0 |
| `e2e/rsi-shape.test.ts` | 1 | 0 | 1 | 0 | 0 |
| `e2e/scoped-system-capabilities.test.ts` | 2 | 2 | 0 | 0 | 0 |
| `e2e/secret-lifecycle.test.ts` | 1 | 0 | 1 | 0 | 0 |
| `e2e/sediment-settings.test.ts` | 1 | 0 | 1 | 0 | 0 |
| `e2e/thinking.test.ts` | 1 | 0 | 1 | 0 | 0 |
| `m2/matt-team.test.ts` | 3 | 0 | 1 | 0 | 2 |
| `m3/production.test.ts` | 11 | 0 | 3 | 0 | 0 |
| `m5/graph.test.ts` | 4 | 0 | 4 | 0 | 0 |
| `m5/http.test.ts` | 6 | 2 | 4 | 0 | 0 |
| `m8/app-shell-ux.test.ts` | 32 | 12 | 20 | 0 | 0 |
| `m8/credentials.test.ts` | 5 | 0 | 5 | 0 | 0 |
| `m8/provider-headers.test.ts` | 4 | 0 | 4 | 0 | 0 |
| `m8/recipe-compile.test.ts` | 9 | 7 | 0 | 2 | 0 |
| `m8/settings-ui.test.ts` | 10 | 10 | 0 | 0 | 0 |
| `m8/startup.test.ts` | 10 | 2 | 8 | 0 | 0 |
| `m8/tool-failure-record.test.ts` | 1 | 0 | 1 | 0 | 0 |
| **小计** | **176** | **14** | **140** | **16** | **7** |

结论：**没有任何一条产品行为是 Go 模型有意丢掉的**（`dropped-in-go` 数量为 0）。所有空缺要么是「Go 侧还没有这条 E2E」，要么是「这条证明写的是 TS 内部实现」，要么是「Go 侧确实少一个能力」。

### Go 侧确实缺的能力

1. **provider 传输证据不存在**。TypeScript 后端每次 provider 尝试都写一条 `provider.transport` 事件（`phase` 为 `fetch_started` / `response_headers` / `transport_error`，带 `requestSha256`、`responseIds`、`usageRecoverableFromTransport`；`src/runtime/pi-adapter.ts:1033`），并且发送 `x-opencode-request-id` 关联头。Go 侧只有 `provider.request_profile`（`backend/internal/graph/runtime_pi_adapter.go:1700`），没有 `provider.transport`、没有关联头。**行为**（传输失败记为未知用量、不静默重发、`reconcile_usage` 收敛）在 Go 里存在，**证据**不存在。`tests/e2e/provider-reconciliation.test.ts` 的 4 条契约因此无法移植——这 4 条要等 Go 补出证据面。
2. **没有确定性的价格校验口子**。`DaemonOptions.PriceVerify` 存在（`backend/internal/graph/server_start.go:31`），但 `serveDaemon` 从不设置它（`backend/internal/graph/server_cli.go:353-356`），校验永远是 `defaultPriceVerify`——去拉归档里的 `sourceUrl`，测试无法指向本地服务。因此「校验成功会抬高版本号并被下一次调用冻结」这一条暂时无法写成真实 E2E。
3. **Matt 团队装配没有可达入口**。`backend/internal/graph/catalog_matt_team.go:40` 的 `AssembleMattTeam` 是个零调用方的库，`server_cli.go` 没有对应 flag，HTTP 路由表里也没有装配入口。TypeScript 侧有 `src/catalog/matt-team.ts` + `examples/assemble-matt-team.ts`。`tests/m2/matt-team.test.ts` 的两条装配契约因此无法端到端证明——要么给 Go 补一个入口，要么把 `examples/assemble-matt-team.ts` 连同其契约一起退役（这是产品决定，不是代码能定的）。
4. **编译失败没有可触发的真实输入**。Go 的 `SavedAgentCombination.CompileError` 由 `recover` 产生（`catalog_catalog.go:176-189`），但 TypeScript 侧那条测试是用 `vi.spyOn` 注入失败的（违反 E2E 规则：不能 mock 自有协作者）。要证明「编译失败时保留配方、不发布定义、报告错误」，需要一个真实能通过校验但编译不过的输入；目前没有找到自然触发点。
5. **两处提示词文本断言不能照搬**。`tests/m3/production.test.ts` 断言的是 TypeScript 的原文（`src/runtime/agent-context.ts`），Go 的公共/主规则文本不同（`backend/internal/graph/runtime_agent_context.go:88,89`），照搬会失败。Go 的用例必须断言 Go 自己的规则文本。
6. **提示词隔离契约在 Go 侧未验证**。TypeScript 用例断言工作节点的提示词不含其他节点的私有指引（`UNRELATED-PROTOCOL-`、`OTHER_NODE_PRIVATE_GUIDANCE`）；Go 的提示词装配在 `catalog_briefing.go` + `core_node_prompt.go`，没有找到显式的排除步骤。这条要靠一次真实的 Go 回合来确认是否仍然成立。
7. **系统工具只剩一半**（Batch 35/36 补齐）。主 Agent 的四个系统工具里，`read_system_capabilities`（宿主清单）在 Batch 35 补上，`inspect_graph_system`（本对话的健康视图）、`propose_system_change` 与 `apply_system_change`（提案 → 批准 → 落地）在 Batch 36 补上——此前 Go 侧只有工具体与参数定义（`runtime_agent_tools.go`），没有实现。TypeScript 那边三个都有实现（`src/runtime/pi-adapter.ts:441+`），但**只有 `tests/m8/system-self-improvement.test.ts` 覆盖它们，而那份测试直接开 `openTaskRuntime`**，属于实现耦合，随 TS 实现一起退休；`tests/m8/conversation-pi.test.ts`（同样实现耦合）只断言主 Agent 的工具表里有这四个名字。

### 移植时的已知陷阱

- **Go 的图布局不是纯 Go**：`backend/internal/graph/server_layout.go:317-357` 会 shell out 到 `node` + `elkjs`。几何类契约的 E2E 必须在 `node_modules/elkjs` 在场的环境里跑——这是最高风险的移植点。
- **`DELETE` 的空 JSON body 400 是 Fastify 的产物**：`tests/m8/recipe-compile.test.ts:211-214` 断言 `DELETE` 带 `content-type: application/json` → 400、不带 → 200，Go 的 `net/http` 没有这条规则。Go 的用例要断言 Go 真实的删除语义，而不是照抄这个框架产物。**Batch 34 已落定**：Go 的 `serveCombinationDelete` 根本不读请求体，于是带不带 `content-type` 都删得掉（200），配方文件里的那条配方真的消失。**这是 Go 更正确的语义，不向 TypeScript 对齐**——那条 400 断言是 Fastify 的内容类型解析器在路由之前就把空 body 拒了，与产品契约无关；TS 用例随实现一起退休。
- **浏览器用例里的 mock 必须换成真实后端**：`tests/m8/app-shell-ux.test.ts` 有八条用例用 `page.route` 伪造应用自己的 `/api/conversations` 响应，还有两条注入了假的 `actions.master`。按仓库规则（只可替代外部服务，不能 mock 自有协作者），这些 fixture 不是有效 keeper——契约保留，证明方式换成真实 Go 进程 + 受控 provider。
