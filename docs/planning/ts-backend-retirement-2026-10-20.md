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
| `console/attachments-payload.test.ts` 附件上限：文本文件进模型、超限被拒不落库、不支持的类型被指名拒绝 | `tests/e2e/go-attachments.test.ts` | 3 |
| `tests/m5/http.test.ts` APP 桥接 RSI 重启队列：无令牌拒绝、队列形状、畸形 ack 拒绝、未知 id 不清空 | `tests/e2e/go-rsi-bridge.test.ts` | 2 |
| `tests/e2e/rsi-shape.test.ts` RSI 真实应用：10 种错误形状被指名拒绝、真实 Git 提交、检查通过、无提交时如实报告、重载请求落地 | `tests/e2e/go-rsi-apply.test.ts` | 3 |
| `tests/m5/graph.test.ts` 图布局几何：盒子在网格上、盒子尺寸合法、走线正交且首尾落在节点边界、走线不穿过节点、同源同目标的边各走各的通道、重画后仍是可画的图 | `tests/e2e/go-graph-layout.test.ts` | 1 |
| `tests/m5/graph.test.ts` 嵌套子图：容器与成员都被画出来、回边落在成员而不是容器上、加节点不动原有节点、删节点后原有节点仍不动 | `tests/e2e/go-graph-nested.test.ts` | 3 |
| `tests/m8/credentials.test.ts` 凭据隔离：两个端点各自只拿到自己的密钥、换模型不会串钥；凭据被撤销后模型不再触达 provider；新任务记下当时生效的配置版本 | `tests/e2e/go-credentials.test.ts` | 3 |
| `tests/m8/startup.test.ts` 启动契约：无效参数/缺控制台/缺配置/缺模型/缺凭据/端口占用/状态目录被占各自报明确错误码；view-only 起得来且不派发；重建控制台不用重启；种子并编译 main 配方；重启保留任务；CLI 打印地址并干净退出；配置拒绝未知引用且相对项目根被解析；密钥只来自被指名的环境变量 | `tests/e2e/go-startup.test.ts` | 10 |
| `tests/m8/provider-headers.test.ts` 模型请求头与凭据隔离：配置的头到达 provider；opencode-go 的路由头在连接测试与真实派发都在；一个解析不出凭据的模型只禁用自己的模型；派发被关掉时建的任务在下一次 execute 启动时救回来 | `tests/e2e/go-provider-headers.test.ts` | 4 |
| `tests/e2e/provider-reconciliation.test.ts` provider 对账证据：关联头即 invocation id；每次尝试留下 fetch_started/response_headers/transport_error 三相证据；请求体的 sha256 与 provider 收到的一致；provider 没答话时不编造用量、不定价；证据里没有密钥 | `tests/e2e/go-provider-reconciliation.test.ts` | 4 |
| `tests/console/price-snapshot.test.ts` 价格刷新：验证失败保留旧金额并标 stale；验证通过重新盖戳且下一次派发冻结新版本 | `tests/e2e/go-price-snapshot.test.ts` | 2 |
| Go 侧自有契约：局部补丁对后来那次提交的路由、过期修订不生效、坏补丁被拒、已受理的活在删边后仍然活着 | `tests/e2e/go-graph-patch.test.ts` | 1 |
| Go 侧自有契约：节点 id 是字面文本（`bracket[1]` / `star*` / `question?`）；已提交过的产出不能再被重试花掉 | `tests/e2e/go-graph-node-identity.test.ts` | 1 |
| `tests/e2e/graph-definitions.test.ts` 定义整体被拒并点名规则；接收协议真的约束值且好值原样通过 | `tests/e2e/go-graph-definitions.test.ts` | 2 |
| `tests/e2e/graph-modules.test.ts` 路由级联与顺序；规则表达式；once 模块的持有与重开 | `tests/e2e/go-graph-modules.test.ts` | 3 |
| `tests/e2e/artifact-publication.test.ts` 发布的版本不可变与 CAS；越界路径与符号链接被拒 | `tests/e2e/go-artifact-publication.test.ts` | 2 |
| `tests/e2e/graph-confirmation.test.ts` 确认后的草稿画得出来、图真的跑起来；旧形状草稿变不成功能 | `tests/e2e/go-graph-confirmation.test.ts` | 2 |
| `tests/e2e/providers.test.ts` provider 目录与探针：目录不泄密钥、探针说厂商协议、拒绝保留厂商原话、坏草稿按字段被拒 | `tests/e2e/go-provider-directory.test.ts` | 4 |

## 低层 206 个文件的孤儿契约审计（结论）

对 45 个高密度低层文件做了一次语义审计（读代码逐条核对，不靠标题匹配——标题匹配会产生 334 条误报）。结论：

| 分类 | 条数 | 处置 |
| --- | --- | --- |
| Go 已有实现，只缺 E2E 证明（`yes`） | 101 | 每条写一条 Go E2E；Go 侧实现点已在审计里指明（file:line） |
| Go 只能弱表达或不能表达（`partial`/`no`） | 16 | 先做 Go 设计决策，再决定写 E2E 还是连同 TS 实现一起退役 |
| 只有 Web 控制台面（`no`，无 Go 面） | 3 | 走浏览器 keeper 轨道，不是 Go E2E：`m8/shell-tabs-ui`、`m8/skill-slash-ui`、`m8/drawer-artifacts-ui` |
| 已被现有 Go E2E 覆盖 | 19 | 无需再写 |
| 已被 149 条 daemon 层契约清单覆盖 | 23 | 无需再写（移植前需与官方清单对账，避免重复） |

审计的重要结论：

- **Go 没有「有意丢掉」的产品行为**。101 条 `yes` 项在 Go 侧都能找到实现点；缺口全部是「没有 E2E 证明」。
- **已证明的进度**：批次 20 证明了 1 条（`node-budget` 的节点配额），批次 21 证明了 4 条（`node-queue` 整份：队列串行、重提额度、provider 真失败花掉自动重试额度、失败节点保留后来的输入），本批之后还剩 96 条 `yes` 没有 E2E 证明。
- **16 条 `partial`/`no` 需要设计决策**，其中值得先看的几条：
  - 「peer message pending 账本」（Go 没有等价物）：影响 `m1/execution` 的两条用量对账规则。
  - 「host check 等待真实 merge 才准入」（Go 有集成/复查机械，但没有等价准入规则）：影响 `m8/kernel-git-integration` 的两条。
  - 「plain directory 变成 Git 仓库」这一步在 Go 侧不可见：`m3/workspace-command` 的一条。
  - 「legacy `graph.verify` 适配器不能劫持原生隔离评审模块」：Go 根本没有 legacy 覆盖路径，该规则在 Go 侧是空真的——按「实现耦合」退休，不是 Go 的义务。
- **UI 半边要另找 keeper**：3 条纯控制台规则不能变成 Go E2E，它们随 Web 控制台的 TS 一起退役。

## Go 侧补齐的能力（退役过程中发现的真实缺口）

退役不是「删文件」，有三条能力在 Go 侧根本不存在或根本是坏的，补齐后才谈得上删：

1. **RSI 的 Agent 工具面没接线**（Batch 10 修掉）。Go 的 `RsiService` 一直存在（状态、重启队列、ack 都有），但 `PiAdapterRsi` 从未被构造——`apply_rsi_change` / `inspect_rsi_status` 对模型根本不存在。补的接线：`core_task_runtime.go` 新增 `piRsiChannel()`，把服务绑成 `PiAdapterRsi`；`runtime_pi_adapter.go` 在 HostTools 里按「master + full access + 有可用 checkout」三个条件暴露这两个工具，并把操作/会话身份带给收据。
2. **形状提示只在 PiG 内核上生效**。`RsiChangeShapeHint` 是 Go 侧的 `PrepareArguments` 钩子，只有 Go 原生的 PiG 内核会调用它；TypeScript sidecar（`--kernel node`）拿不到这个 Go 函数，模型只会看到 schema 报错。**等 PiG 内核接管主会话后**，形状提示才与 TS 行为一致；在此之前 schema 报错仍然逐字段指名（`changes.0.edits.1.oldText: must have required properties ...`），契约「模型知道自己错在哪」成立。
3. **嵌套子图在 Go 侧是坏的**（Batch 12 修掉）。两处同一族的错误：Go 端口把展开后的成员以**带类型**的值（`NodeDefinition` / `map[string]GraphIo`）塞进 `map[string]any`，随后又用 `.(map[string]any)` 断言读回来——断言失败，于是
   - 子图的输入/输出引用（`inner.job`）解析不到，报 `Unknown subgraph input inner.job`；
   - 指向子图成员的验收项读不到 `recipe`，报 `Acceptance works must name an agent reviewer`。
   修法：展开出来的成员一律存成普通记录（`interfaceSpecAsMap`），引用解析同时认普通记录与带类型的端口表。**结论：子图功能此前在 Go 侧从未真正跑通过**，审计里那条「Go 已有实现」只是读代码读出来的。
4. **一个没有凭据的模型能弄坏另一个模型的回合**（Batch 15 修掉）。主 Agent 回完话之后会额外发一次「下一条输入建议」的请求，而选这次请求用哪个模型时只看目录、不看凭据：目录里排第二的模型没有可用密钥，于是建议请求在取密钥时抛 `No credential bound for model unusable`，这个异常一路冒泡回主回合，主回合被判为 `operation.unknown`，master 被 park 成 pending 并开 recovery question——**用户已经收到的回复被收走**。两处修法：`piAdapterCallableModels` 只让凭据真的能解析的模型进入候选；`piAdapterGenerateSuggestion` 自己吞掉异常，把失败变成建议结果里的 `error`，绝不掀翻主回合。
5. **派发被关掉时建的任务永远救不回来**（Batch 15 修掉）。TypeScript 在 `openTaskRuntime` 里就调用一次 `recoverMasterNodes()`，所以 view-only 期间建的任务在下一次 execute 启动时会被补上 master 节点；Go 只在热改配置时调 `RecoverMasters`，启动路径上根本不调——任务永远停在「没有 master 节点」的状态。而且 Go 的 `RecoverMasters` 也不像 TS 那样在补完节点后把第一个 discussing 任务设为 `active_task`，补出来的节点因此进了不了派发车道。修法：`OpenTaskRuntime` 末尾调用一次 `RecoverMasters()`；`RecoverMasters` 在没有 active task 时把第一个 discussing 任务设为 `active_task`。
6. **provider 的传输证据面在 Go 侧根本不存在**（Batch 16 补掉）。TypeScript 每次 provider 尝试都写一条 `provider.transport` 事件（`fetch_started` / `response_headers` / `transport_error`，带 `requestSha256`、`responseIds`、`errorCodes`、`errorNames`、`usageRecoverableFromTransport`），并给 opencode-go 网关发一个 `x-opencode-request-id` 关联头；Go 侧只有 `provider.request_profile`，证据面缺失，ADR 0034 明确点名这是删 TS 实现前必须补的。补法：新增 `runtime_provider_transport.go`（观察的载体、请求体 sha256、响应相关 id、只带标识符的失败命名）；`ControlledGatedProviderFetch` 增加 `OnTransport` 与 `RequestIDHeader`；适配器在主回合、输入建议、技能沉淀三处都写事件。
7. **价格校验永远是网络请求，真实 E2E 指不到本地服务**（Batch 16 补掉）。Go 的 `DaemonOptions.PriceVerify` 一直存在，但生产路径永远走归档 `sourceUrl` 的网络抓取；TypeScript 那边靠 `startGraphDaemon` 的 `priceVerify` 注入点做确定性验证。补法：daemon 读 `GRAPH_PRICE_SOURCE_URL`，把校验指向另一张价格页（镜像、代理、本地服务），**校验语义不变**——页面仍然必须提到该模型，提不到就是验证失败，绝不静默改价。
8. **先推理再调工具的回合会把自己覆盖掉，整回合失败**（Batch 18 修掉）。Go 的受控流把 **provider 的工具调用序号**当成了**消息内容块下标**：一个回合先吐 `reasoning_content`（占住内容块 0）再发 `tool_calls`（provider 序号也是 0）时，工具调用把 thinking 块整个覆盖掉，并让帧编码器撞上「同一个内容块开始了两次」，整个回合被判失败（`Assistant message block 0 starts more than once`）。TypeScript 那边由 Pi SDK 分配内容块下标，思考块与工具块本来就是两块，从来没有这个碰撞。修法：把「provider 的工具序号」与「消息内容块下标」分成两个数——`toolCalls` 仍按 provider 序号合并参数增量，另加 `toolBlocks` 记内容块下标；OpenAI 路径的工具调用占下一个空块，Anthropic 路径的块序号本来就是内容块下标，原样使用。
9. **沉淀开关永远读不到**（Batch 19 修掉）。Go 的**活配置是解析后的结构体**（`LiveConfig.Config()` 返回 `GraphConfig`），而沉淀设置的读取函数 `SedimentSettingsFrom` 只认 `map[string]any`：类型断言失败 → 永远拿回默认值（关闭）——配置面能存、能显、能校验，活运行时却当这个开关不存在，于是沉淀复审永远不发生。TypeScript 那边活配置是普通对象，同一段读取逻辑一直是对的。修法：`SedimentSettingsFrom` 认得解析后的 `GraphConfig`（直接取 `Skills.Sedimentation`），同时也继续认原始文档。
10. **两个节点并行时 daemon 直接崩**（Batch 20 修掉）。Go 的图 lane（`runtime_kernel_graph_lane.go`）把每节点的会话、宿主、绑定、绑定摘要、恢复快照放在**几张普通 map** 里，而 `GraphRunner.Drain` 是**每个节点一个 goroutine**——一张图有两个节点同时开工时，两个 goroutine 写同一张 map，Go 的运行时直接判 `fatal error: concurrent map writes`，**整个 daemon 进程当场退出**（不是丢一次更新，是把服务打死）。TypeScript 是单线程事件循环，同一段逻辑没有这个窗口。修法：这几张表统一由一把 mutex 守护，所有读写走访问器（`sessionOf` / `setSession` / `hostOf` / `setHost` / `forgetNode` …），关图与关运行时也改成「先在锁内快照键，再在锁外销毁」。
11. **provider 调用记录读不出状态与预留**（Batch 20 修掉）。`KernelProviderCall` 结构体**没有 JSON tag**，于是它序列化出来是 `Id` / `State` / `Reserved` 这些大写键；而读它的两处（节点运行视图 `KernelNodeRun` 的 `invocations`、`graph_inspect` 的 `provider_calls`）都按小写的 `state` / `reserved` / `executionId` 去读——读出来永远是空值。所以「这一发 provider 调用是不是还在飞、占了多少预留」在 Go 侧根本看不到，图视图与 `provider_calls` 查询都缺了 TypeScript 那边有的那一半事实。修法：给结构体补上与 TypeScript 同形的 JSON 名（`id` / `nodeId` / `executionId` / `reserved` / `state` / `usage` / `model` / `purpose` / `cost` / `createdAt` / `settledAt`）。
12. **队列与执行历史读不出来**（Batch 21 修掉）。`QueueHistoryPage` / `ExecutionHistoryPage` / `ExecutionHistoryItem` / `ExecutionRow` 同样**没有 JSON tag**，序列化出来是 `Items` / `Cursor` / `RetriesUsed`；而 `graph_inspect` 的 `queue` 与 `executions` 查询、模型读到的工具结果，都按小写的 `items` / `cursor` / `retriesUsed` 去读。于是「图上排着哪些活、一次执行用掉了几次自动重试与几次重提」在 Go 侧只剩下一半事实：模型看到的是 `Items`，而按 `items` 读的人什么也读不到。修法：给这四个结构体补上与 TypeScript 同形的 JSON 名。
13. **工具的拒绝理由在跨进程边界上被整个丢掉**（Batch 22 修掉）。TypeScript 的工具体与 worker 在同一个进程里，工具抛错由 SDK 直接变成模型读到的错误结果，理由在。Go 的工具体在 daemon 进程里，worker（TypeScript sidecar）在另一个进程：daemon 把工具体抛出的 `RuntimeError` **当成一个普通的返回值**回传（`runtime_worker_requests.go` 的 tool 分支），于是 worker 收到的是 `{"Code":"invalid_input","Message":"…"}` 这样一坨没有 `content` 的东西——worker 自己的校验（`src/runtime/durable-tools.ts`）判定「这不是一个工具结果」，抛一句 **`Tool returned an invalid content result`**。模型最终看到的是这一句**通用**话术，拒绝的真实原因一个字都没有。后果很实际：模型无法从「创建请求 id 已用于别的定义」这类拒绝里学到任何东西，只能反复重试同一次调用。修法：daemon 在工具边界把拒绝**转成 worker 认得的工具结果**（`content` 里放原因，`isError: true`），理由原样回到模型面前。PiG 内核这条路本来就不受影响（它把错误文本包成 `Tool failed: <原因>`），修完之后两条路的语义一致。
14. **投递与补丁的结果读不出来**（Batch 23 修掉）。同族的形状 bug：`DirectDelivery`（`{delivery, queue}`）与补丁的返回值（`{revision}`）**都没有 JSON tag**，序列化出来是 `Delivery` / `Queue` / `Revision`。TypeScript 那边的 `graphSend` 回答 `{ delivery: { source, edgeId, fromEndpoint, toEndpoint, protocol, value, revisionVersion }, queue? }`、`graphPatch` 回答 `{ revision }`；Go 侧模型读到的是大写键，于是「这一笔投递到底从哪来、落在哪个端点、值是多少」与「补丁发布出去的是第几版」这两件事**在 Go 侧读不到**——按小写键读的人什么也读不到。修法：`DirectDelivery` 补上 `delivery` / `queue`（`queue` 为空时省略），补丁的返回值换成有名结构体 `GraphPatchResult`（`revision`）。
15. **显式的 null 被当成「没写」，整份坏定义被放行**（Batch 25 修掉）。Go 的定义校验按「值不是 nil」判断字段是否在场，于是 `model: null`、`instructions: null`、`retry: null`、`budget: null` 这些**显式的 null**（类型错误）全被跳过——TypeScript 那边 `settings.model !== undefined` 这类判断把 null 与「没写」分得很清楚，四种都被拒。后果不只是宽松：一张用 `model: null` 建出来的图**真的被创建了**，模型随后拿到的是一张自己没写对的图。修法：改成按「键在场」判断（`_, ok := settings["model"]`），在场就必须是对的类型。
16. **没写额度的预算被当成「不限额」**（Batch 25 修掉）。`budget: {}`（没有 `tokens` 键）在 Go 侧被当作「tokens 缺失 = 不限额」而接受；TypeScript 那边要求 `tokens` 必须在场（要么是非负整数，要么显式的 null）。一条漏写额度的预算因此会静悄悄地变成无限额度。修法：`tokens` 键必须存在，缺了就按 `budget.tokens must be a non-negative integer or null` 拒掉。
17. **协议 schema 只认六个关键字，声明的协议几乎不约束任何东西**（Batch 25 修掉）。Go 手写的协议值检查（`interfaceSpecCheck`）只实现了 `type` / `required` / `properties` / `minLength` / `minimum` / `integer`；TypeScript 那边用 ajv 严格模式，`enum` / `const` / `items` / `minItems` / `maxItems` / `uniqueItems` / `additionalProperties` / `maxLength` / `maximum` / `pattern` 全部生效。后果很实际：**一个声明了严格协议的图，收到的却是任何值都被接受**——枚举值、数组元素、最少元素个数、多出来的字段，一概不检查。另一半缺口在定义侧：协议承诺的类型名没人认识时（`type: 'not-a-type'`）Go 侧照样把定义建出来，于是那张图收任何值都会被拒。修法：值检查补齐那十个关键字（含数组的元组写法与 `additionalProperties` 的 schema 写法）；定义侧要求 `type` 只能是 JSON Schema 认识的类型名，否则整份定义被拒（`Protocol <id> has an invalid schema: ...`）。
18. **会话的草稿图永远是空的**（Batch 27 修掉）。`GET /api/conversations/{id}/draft-graph` 把提案的 `spec` 按 `map[string]any` 断言，而会话视图里的 `spec` 是 **`NativeProposal` 结构体**——断言当场失败，于是这份草稿**永远画不出来**：`nodes` 是空的、`layout.edges` 是空的、`interfaces` 是空的。控制台在确认之前看不到任何东西，用户只能对着「确认」按钮点头，却不知道要确认的是什么。TypeScript 那边把 `spec` 序列化成对象再取 `definition`，草稿是画得出来的。修法：按 `NativeProposal` 与 `map[string]any` 两种形态分别取定义，取不到就照旧返回空图。
19. **任何合法的 provider 地址都被判为非法**（Batch 28 修掉）。Go 的 `isHttpURL` 用 `url.Parse` 解析地址后，把 `parsed.Scheme` 拿去和 `"http:"` / `"https:"` 比——而 Go 的 `url.URL.Scheme` **不带冒号**（值是 `http`），**这个比较永远不成立**。于是每一个带 Base URL 的 provider 草稿都被拒（`Base URL 必须是 http(s) 绝对地址`），**探针面整条路都不可用**：厂商的模型列表探不到、凭据验不了，`POST /api/providers/probe` 只会回 400。TypeScript 那边用 `new URL(value)`，`protocol` 是带冒号的 `http:`，比较成立。修法：scheme 不带冒号，比 `"http"` / `"https"`。
20. **不带参数的工具在 Go 侧整个调不动**（Batch 29 修掉）。Go 的 `AssistantContentBlock` 是一个「文本 / 思考 / 工具调用」共用的结构体，参数那一份字段标了 `json:"arguments,omitempty"`——而 **`omitempty` 会把空对象整个丢掉**。于是「这个工具不需要参数」的那一类调用（`list_projects`、`list_agent_combinations`）传出去的 `arguments: {}` 变成了**没有 arguments**，worker 侧的 SDK 校验立刻判它非法：`Validation failed for tool "list_projects": - root: must be object / Received arguments: undefined`。**目录面在 Go 侧整条不可用**：主 Agent 读不到项目、读不到子 Agent 配方。TypeScript 那边 `ToolCall.arguments` 是必填的，`JSON.stringify` 不会丢掉 `{}`。修法：给内容块写自己的序列化——**工具调用块一定带 `arguments`（哪怕是 `{}`）**，文本块与思考块照旧不带；帧里的 `toolcall_end` 也一样保证参数对象在场。
21. **撤销之后的迟到确认会把密钥复活**（Batch 29 修掉）。daemon 的密钥桥接里，「这个引用当前有没有值」被写成了「这个引用有没有被撤销过」：一旦某把密钥被撤销（登出），它的**当前值**就应该是「没有」；而迟到的那次持久化确认带着旧值回来时，代码把「已撤销」误当成「没有当前值」，于是**不判它过期**、也不重新排队删除，**那把用户已经登出的密钥又回来了**。TypeScript 那边把「已撤销」与「没值」分成两件事看。修法：把两者分开记——已撤销也算「有当前值」（值是「没有」），于是迟到的确认被判为过期，删除被重新排队，密钥不会复活。
22. **模型发错的参数被悄悄改写成空对象**（Batch 29 修掉）。Go 的受控流在解析 provider 发来的工具参数时，把**不是对象**的参数一律换成 `{}`（`controlledToolArguments` 的 `map[string]any` 断言失败就退回空对象）。于是模型发来 `arguments: "not an object"` 时，worker 侧的校验看到的是**一个空对象**，报的是「缺 `title` 与 `problem`」——**模型犯的错被改写成了另一个错**，它收到的反馈与它真正写错的地方对不上。TypeScript 那边（Pi SDK）保留参数的原值，于是校验说的是 `root: must be object`，并把它收到的东西原样展示出来。修法：参数值不再被窄化成对象，原样过界；内容块自己序列化时保证**工具调用一定带参数**（空参数集是 `{}`），别的块种照旧不带。
23. **没有可用凭据时，用户的请求被无声地吞掉**（Batch 30 修掉）。Go 的 master 模型取的是「目录里第一个凭据能解析的模型」；当一把都解析不了时它就是空的，于是 **master 节点根本不建**——会话里的那条用户消息永远停在 `pending`，`master` 为 null，没有任何事件、没有任何问题、没有任何原因，用户既看不到发生了什么，也无从下手。TypeScript 那边同样安静（两边的 `masterModel` 取法一致），但这是一处**能力缺口**：2026-10-21 定夺按「拒绝并给出原因」处理。修法：分发闸门在**根本没有回合可跑**时把原因说出来——会话里写一条系统错误消息，用的正是「本轮没有启动起来」那套现成话术，**用户的消息保留**（它从未被投递过），于是密钥一回来它就照常跑完。

## 执行批次

每批结束都要求 `node --run check` 全绿，并显式更新 `tests/suite-baseline.json`（`node --run check:baseline` 是门禁，缩减用例必须显式落账，不允许靠改基线掩盖失败）。

- **Batch 1（已完成）**：Go 任务面 HTTP 契约。`tests/e2e/go-task-http.test.ts`——真实 `graphd` 进程、真实回环 HTTP、真实状态目录；证明任务可创建/列举/读回、事件游标可断点重连、命令通道对匿名与跨源调用关闭。
- **Batch 2（已完成）**：会话创建的模型与思考档位。`tests/e2e/go-conversation-http.test.ts`——证明用户选的模型与思考档位落在会话上，并且真正到达该模型指向的 provider。
- **Batch 3（已完成）**：桌面 APP 桥接的密钥生命周期。`tests/e2e/go-app-bridge.test.ts`——证明推送的密钥生效、密文不落配置文件、撤销留下持久记录、无令牌被拒。
- **Batch 4（已完成）**：运行中 daemon 的配置语义。`tests/e2e/go-hot-config.test.ts`——证明热保存后新项目立即可用、被拒候选不落盘且 daemon 保持原配置、撤销跨重启仍然生效、损坏的撤销文件 fail-closed、两个凭据的撤销都被记录。
- **Batch 5（已完成）**：暂停与恢复。`tests/e2e/go-pause-resume.test.ts`——证明暂停期间到达的消息不会到达 provider、恢复后放行、暂停是任务的事实因而跨重启保持。
- **Batch 6（已完成）**：队列消息的撤回。`tests/e2e/go-conversation-queue.test.ts`——证明排队中的消息可以撤回、同一请求不重复撤回、不存在的消息报 missing 而不是被编造。
- **Batch 7（已完成）**：项目移出配置。`tests/e2e/go-removed-project.test.ts`——证明历史仍然可读、项目从控制台消失、新任务被明确拒绝而不是被静默接受。
- **Batch 8（已完成）**：消息的附件上限。`tests/e2e/go-attachments.test.ts`——证明限额内的文本文件随消息进到模型手里，超限文件被指名拒绝且不留消息，不支持的类型被指名拒绝。
- **Batch 9（已完成）**：APP 桥接的重启队列。`tests/e2e/go-rsi-bridge.test.ts`——证明无令牌被拒、队列形状可读、畸形 ack 被拒、未知 id 不会清空任何东西。
- **Batch 10（已完成）**：RSI 的真实应用流程。`tests/e2e/go-rsi-apply.test.ts`——模型发出 10 种错误形状的 `apply_rsi_change`，每一种都被逐字段指名（不落一个字节、不建分支、不提交）；改对之后真的改写真实 checkout、跑真实检查、提交到 `rsi/*` 分支；无改动的复查如实报告「没有产生提交」；`activate=true` 真的落下重载请求。
  - 这一批先补了 Go 的能力：`PiAdapterRsi` 之前是死代码，模型压根看不到这两个工具（见上文「Go 侧补齐的能力」）。
  - 用例跑在 `--kernel pig` 上：Go 原生的 PiG 内核才会调用 `PrepareArguments` 形状提示钩子。
- **Batch 11（已完成）**：图布局几何契约。`tests/e2e/go-graph-layout.test.ts`——真实 `graphd` + 真实 elkjs（`node_modules/elkjs` 在场）画出一张带「同源同目标四条边 + 一条回边」的图，证明盒子都在 16px 网格上、盒子尺寸合法、每条走线正交且首尾正好落在源/目标节点的边界、任何走线都不穿过任何节点、两条不同的走线不互相压住（共享引出段与共享到达段除外）、同源同目标的四条边各走各的通道；并发读两次得到同一份布局，重画之后仍然是一张可画的图。
  - 几何判据（网格、尺寸、正交、不穿越、通道分离）逐条对照 `tests/m5/graph.test.ts` 的 TS 判据，包括它那两条豁免（共享引出段、共享到达段）。
  - 例子里的 9 张图（`examples/graphs/*.json` 与 review pattern）暂未整体移植：本批用一张自带的图覆盖同一批几何规则；`examples/` 的文件本身在删除清单里，移植时要一并搬进 `tests/fixtures/` 或退休。
- **Batch 12（已完成）**：嵌套子图的布局契约。`tests/e2e/go-graph-nested.test.ts`——一个可复用图被实例化进大图后，容器、实例与成员都被画出来，回到起点的回边落在**成员**（`outer/inner/work`）而不是容器上；加一个节点不动原有节点的位置，删掉它之后原有节点仍然不动。
  - 这一批逼出了 Go 侧的两个真 bug（见上文「Go 侧补齐的能力」第 3 条）：**嵌套子图此前在 Go 侧根本无法定义**。
  - 用例跑在 `--kernel pig` 上（当时 TypeScript sidecar 会把 Go 工具的错误吞成一句「Tool returned an invalid content result」，PiG 内核才会把真实原因交回给模型；Batch 22 之后 sidecar 那条路也不再吞理由）。
- **Batch 13（已完成）**：凭据隔离与配置版本记账。`tests/e2e/go-credentials.test.ts`——两个端点各自只看到自己的 `Bearer` 密钥（换模型不串钥）；凭据被撤销后模型不再触达 provider；新任务在 `task.created` 事件里记下当时生效的配置版本。
  - **发现一处行为差异（待修）**：TypeScript 在模型没有可用凭据时让节点**失败并给出原因**（`no credential bound`）；Go 的分发闸门只是**等待**——对话停在 pending，`master` 为 null，用户看不到任何原因。已证明的部分（不外发、不假装答完）写进了用例；「给出原因」这一半还没有 Go 实现，列入待补。
- **Batch 14（已完成）**：daemon 的启动契约。`tests/e2e/go-startup.test.ts`——直接驱动真实 `graphd` 二进制，把 `m8/startup.test.ts` 的 10 条契约整份移植：无效参数以 usage 退出（exit 2）；缺控制台、缺配置、缺模型、缺凭据、端口占用、状态目录被占各报自己的错误码；view-only 起得来、报得出启动状态、且一个回合都不派发；重建控制台不用重启进程；种子并编译出 main 配方；重启后同一状态目录里的任务还在；CLI 打印地址、SIGTERM 干净退出（exit 0）；配置拒绝未知引用与非法取值、相对项目根被解析成绝对路径；密钥只从被指名的环境变量取，配置接口永远不带明文。
- **Batch 15（已完成）**：模型请求携带的东西。`tests/e2e/go-provider-headers.test.ts`——移植 `m8/provider-headers.test.ts` 的 4 条契约：配置的头真的到达 provider（连同该模型自己的 `Bearer`）；opencode-go 的路由头在连接测试和真实派发里都在；**一个解析不出凭据的模型只禁用自己的模型，不禁用别人的派发**（可用模型照常回完话，用户拿得到回复，没有 recovery question，没有 `operation.unknown`，而且那个不可用模型根本没有被问过）；**派发被关掉时建的任务在下一次 execute 启动时被救回来**（补出 master 节点、记下 `task.master_recovered`、真的向 provider 发请求、带着这一轮才有的密钥），而项目已被移出配置的那个任务保留历史但不被救活。
  - 这一批逼出了 Go 侧的两个真 bug（见上文「Go 侧补齐的能力」第 4、5 条）：**一个没有凭据的模型能弄坏另一个模型的回合**，以及**派发被关掉时建的任务永远救不回来**。
  - TS 的第 3 条用例走的是原生图的 worker 节点，Go 这边走的是会话的 master：master 回合之后多一次「输入建议」的请求，正是这条路径把 bug 逼了出来。断言按 Go 自己的语义写（`prompt_suggestion.decided` 的 `asked:false` / `model:null`），不照抄 TS 文本。
- **Batch 16（已完成）**：ADR 0034 点名的两个 Go 侧缺口。`tests/e2e/go-provider-reconciliation.test.ts`（4 条）移植 `e2e/provider-reconciliation.test.ts` 的四个变体：provider 收到的关联头就是那条 invocation 的 id；每次尝试都留下 `fetch_started`（请求体的 sha256 与 provider 真正收到的那份一致）、`response_headers`（状态码与 provider 回的相关 id）、`transport_error`（只带标识符，不带可能含 URL 的报文）三相证据；provider 答了话，用量就是 provider 自己报的数并被定价；provider 没答话，用量保持未知、每一次尝试都不定价——账本保留那个缺口，不编造用量；证据里没有密钥、没有 authorization、没有 cookie。
  - `tests/e2e/go-price-snapshot.test.ts`（2 条）移植 `console/price-snapshot.test.ts` 的两条 daemon 级契约：验证失败时旧金额原样保留、条目标成 stale（不填零、不静默改价）；验证通过时价格重新盖戳，下一次派发冻结的正是新版本（invocation 的 `priceRevision` 等于新 catalogRevision，金额按新费率算）。
  - 这一批先补了 Go 的能力（见上文「Go 侧补齐的能力」第 6、7 条）。
  - **一处行为差异（已定夺：不对齐，有意保留）**：Go 把 `503` 也当成容量答案重试（最多 3 次），TypeScript 只重试 `429`——TS 的理由是代理可能把上游的模糊失败翻译成 503，那种请求可能已经被计费。Go 每一次尝试都记成未知用量、不定价，所以「账本保留缺口、不编造用量」这条契约在两边都成立，但**到达 provider 的请求次数不同**。用例按 Go 自己的语义断言（容量答案重试且每次尝试都被记账）。**2026-10-21 定夺：不向 TypeScript 对齐**——Go 侧的容量重试是它自己的策略，这处差异作为**有意保留**记录在案，不再是待修项。
- **Batch 17（已完成）**：主实例的预算记忆与在途计费。`tests/e2e/go-main-budget.test.ts`（4 条）移植 `tests/e2e/main-budget.test.ts` 的两条契约：
  - **在途用量计入预算**（3 个变体，限额 2_050_000 / 2_052_256 / 2_060_000）：主操作预留 2M tokens，每次真实 provider 发送预留 contextWindow+maxTokens（32000+256）。第一条回复的 20,000 token 在操作结算之前就已经是权威事实，所以它必须计入**下一次**发送的判断——限额 2_050_000 时第二次发送被拒（total = 0 + 20_000 + 2_000_000 + 32_256 = 2_052_256 > 限额），操作变成 `interrupted`、master 被一个 budget question 挡住、用量 20,000 照记；限额 2_052_256 与 2_060_000 时第二次发送放行，操作 `succeeded`，用量 20_050。
  - **换模型与重启都不清空记忆**（1 条）：实例记着自己用过哪些模型（`['first']`）、花过多少 token（53 = 主回合 50 + 输入建议 3）、预算 scope 的 id/used/limit/members；换成 unlimited 之后 `budget` 变 null 而 `used` 不动；daemon 重启后实例 id、scope id、used、unlimited 全部还在；后续两轮把 used 推到 106/159、`modelsUsed` 变成 `['first','next']`，而第一个模型只被问过一次、第二个模型两次、便宜模型三次（每轮一次输入建议）。
  - **一条必须记住的 Go/TS 同构事实**：预算闸门（派发前 `AssertWithinBudget` 与发送前的 `TaskSendGate.Check`）**在全权访问（`mode: "full"`）下被跳过**——TS 的 `src/runtime/task-gate.ts:37` 与 `src/core/execution.ts:523` 就是这么写的，Go 的 `backend/internal/graph/runtime_task_gate.go:96` 与 `core_execution.go:933` 一模一样。TS 那条契约用的是 `standardAccessPolicy()`，所以 Go 用例必须显式写 `access: { mode: "standard" }`，否则闸门根本不会被问到，限额形同虚设。后续凡是「预算/用量/额度」类契约都要按这条配。
  - `modelsUsed` 记的是 `modelId ?? id`（TS 的 `src/core/execution.ts:493` 与 Go 的 `core_execution.go:860` 同构），所以夹具要像 TS 那样让 `modelId` 与 `id` 相同，断言才是 `['first']`。
- **Batch 18（已完成）**：会话面：回合失败与工具回合的收尾。`tests/e2e/go-conversation-runtime.test.ts`（2 条）移植 `tests/e2e/conversation-runtime.test.ts` 的前两条契约：
  - **输出被截断的回合结算成一条可行动的提示**：模型把整段输出花在推理上并停在输出上限上时，回合必须结算——用户看到一条 `system`/`error` 消息（Go 自己的文案：「主 Agent 本轮的模型输出被截断，回复没有完成……」），操作结算为 `failed` 且记下真实原因（`Model response hit the output token limit before completing the reply`），master 被一个 main 自有的 `execution_failed` 问题 park 住（等用户下一次说话），而不是永远停在 dispatched。
  - **工具回合即使连接不关闭也不拖住后续回合**：一轮里读四个 512KB 文件后照常回答；下一轮模型调 `artifact_publish` 而 provider 在 `[DONE]` 之后**不关闭连接**、工具本身又失败时，回合不能被拖住——工具错误回到模型、模型被再问一次、回合正常收尾，provider 真的被问了四次；那次被截断的调用仍按 provider 报的用量记账（`authoritative`，128/256）。
  - 这一批逼出了 Go 侧的一个真 bug（见上文「Go 侧补齐的能力」第 8 条）：**先推理再调工具的回合会把自己覆盖掉**。
  - 第三条契约（native 交付失败 → 通知 main → 用户决定进入新的显式输入）**暂时无法按原样移植**：它需要 supervisor 级别的 `graphCreate`/`graphSend`/`graphInspect`，而 Go daemon 的公开 HTTP 面与 TS daemon 一样只有 `graph/control`（pause/resume/skip/cancel…），没有建图与投递输入的入口。**可行的替代路径已经找到**：主 Agent 本身带着 `graph_create` / `graph_send` / `graph_inspect` / `graph_control` 四个图工具（`runtime_agent_tool_definitions.go`），所以「图生命周期 / 节点预算 / 节点队列 / 产物发布 / 图定义」这一簇可以改由**会话面**证明——让模型在真实对话里调这些工具，daemon 侧仍然是真实的图执行。图生命周期这一簇（约 30 条上下）按这条路走。
- **Batch 19（已完成）**：自改进：沉淀开关与真实的沉淀复审。`tests/e2e/go-sediment-settings.test.ts`（1 条）移植 `tests/e2e/sediment-settings.test.ts`：控制台看到的默认值就是 `skills.sedimentation` 的默认值；把开关打开是一次真的保存，保存后的文档再存一次也认；六个非法取值（`enabled: 'yes'`、`afterToolCalls: 0`、`afterToolCalls: 2.5`、`budgetTokens: -1`、`model: '   '`、`model: 'nobody'`）各自按字段名被拒（400，且报的是 `skills.sedimentation.<字段>`），磁盘上的配置文件一个字节都没动；真的工具回合（模型用 `read` 读了项目里的文件）赚来一次真的复审——复审走用户选定的 reader 模型（`model: 'reader-model'`）、带 reader 自己的凭据（`Bearer reader-synthetic`）、带着主回合的回复。
  - 这一批逼出了 Go 侧的一个真 bug（见上文「Go 侧补齐的能力」第 9 条）：**沉淀开关永远读不到**，配置面与运行时脱节。
- **Batch 20（已完成）**：图生命周期：节点配额。`tests/e2e/go-node-budget.test.ts`（1 条）移植 `tests/e2e/node-budget.test.ts` 的整条契约，走的是**会话面**那条替代路径——主 Agent 在真实对话里用 `graph_create` 建图、用 `graph_send` 投递输入，daemon 侧仍然是真实的图执行：
  - **在途的回合持有预留**：节点回合开始前，Go 按 `DEFAULT_V2_RESERVE_TOKENS`（200_000，与 TS 同值）预留一个回合的额度；provider 被挂住时，节点视图里 `instance.reserved = 200_000`、`used = 0`，provider 调用是 `inflight` 且带预留。
  - **结算后按真实用量记账**：回合结束释放预留、记下 provider 报的用量（40+10=50/回合），三个被接受的回合之后 `used = 150`、`reserved = 0`。
  - **每个节点各记各的账**：无限额节点（`budget.tokens: null`）在同一时刻是 `unlimited: true`、`reserved: 0`、`used: 0`——另一个节点的预留不会漏进它的账本；它自己的回合按自己的用量结算（20_000_001）。
  - **只拒耗尽的那个节点**：第四个回合在预留时超限（150 + 200_000 > 200_100），节点变成 `blocked`、provider 一次也没被问第四次（3 次真实请求），并在图上 park 一个 `budget` 问题（`kind: budget`、`nodeId: finite`、`status: open`）等用户授权增量。
  - 这一批逼出了 Go 侧的两个真 bug（见上文「Go 侧补齐的能力」第 10、11 条）：**两个节点并行时 daemon 直接崩**（lane 的每节点表被并发写），**provider 调用记录读不出状态与预留**（结构体没有 JSON tag）。
- **Batch 21（已完成）**：图生命周期：节点队列。`tests/e2e/go-node-queue.test.ts`（4 条）**整份**移植 `tests/e2e/node-queue.test.ts`，同样走会话面那条路径：
  - **一个节点把投递、排队的聊天与后来的投递串成一条线**（第 1 条）：第一个投递在 provider 上被挂住时，节点 a 的队列是 `[delivery claimed, chat queued, delivery queued]`——后来的聊天与投递排在它后面，而不是插到它前面；另一个节点 b 不在这条队列里，它的执行已经 `completed`；挂住的那次调用里看不到后到的聊天文本；放行之后队列变成 `[delivery done, chat done, delivery done]`，节点 a 有三次 `completed` 的执行，provider 被问了 5 次（其中第 3 次的上下文里带着那条排队的聊天），图的结果是提交出去的两个值 1 与 3。
  - **重提额度只花一次，且花掉的重提在重启后还在**（第 3 条）：节点没交出必需产出时，回合按额度被重提——默认额度 1，于是第一次重提之后节点 `failed`（`retries_used: 0`、`resubmits_used: 1`，provider 被问 2 次）；节点自己声明 `retry: {automatic: 4, resubmit: 2}` 时可以被修两次（`resubmits_used: 2`、`completed`，provider 被问 4 次）。两种情况下重启 daemon（同一个状态目录）之后记账原样保留，provider 也没有被再问一次。
  - **provider 真失败会花掉自动重试额度**（第 4 条）：模型端真的返回 404 时，节点按额度自动重试——默认额度 2，于是节点 `failed`（`retries_used: 2`、`resubmits_used: 0`，provider 至少被问 3 次）；节点自己声明 `retry: {automatic: 4, resubmit: 1}` 时重试 4 次（`retries_used: 4`）。两种情况下重启 daemon 之后额度仍然花完，provider 没有被再问一次。
  - **失败的节点在重启后保留后来的输入，由显式的 skip 与 resume 释放**（第 2 条）：节点 a 的第一个投递没交出必需产出而失败（`retry: {automatic: 0, resubmit: 0}`），后来的投递留在队列里，节点 b 不受影响地完成；重启 daemon 之后队列仍是 `[delivery failed, delivery queued]`，provider 没有被再问一次；显式 `skip` 掉失败的那个条目、再 `resume` 节点之后，排队的投递才跑起来并交出值 3（provider 共被问 3 次），而已提交的活不能再被 `retry`（被拒，错误码 `invalid_queue`）。
  - 这一批逼出了 Go 侧的一个真 bug（见上文「Go 侧补齐的能力」第 12 条）：**队列与执行历史读不出来**（分页结构体没有 JSON tag）。
- **Batch 22（已完成）**：图生命周期：建图请求的恢复与冲突。`tests/e2e/go-graph-create.test.ts`（1 条）移植 `tests/e2e/graph-create.test.ts` 的那条契约（**Git 准备失败后同一创建请求恢复、不铸第二个图**），走会话面那条路径——主 Agent 在真实对话里用 `graph_create` 建图：
  - **准备失败不是丢了的请求**：目标分支还不存在时（真实 `git init -b other` 的仓库），建图请求返回 `state: 'blocked'`，理由指名分支（图在等分支，不是在等用户）；图是 `paused` 的。
  - **修好之后同一个请求 id 捡回同一张图**：真的 `git branch main` 之后，同一个 `requestId` 再次调用 `graph_create` 命中 `replayed: true`，graphId 与当初那张一致，图不再 `paused`。
  - **同一个请求 id 换内容被拒，且不动已有的图**：第三次 `graph_create` 带着不同的定义，模型读到的是**拒绝的真实理由**（`Creation requestId was already used with a different definition`），结果里**没有** graphId（被拒就不铸图），`graph_inspect` 看到的仍是原来那张图（名字还是 `Recover creation`），`GET /api/tasks` 里的图任务仍然只有那一张。
  - 这一批逼出了 Go 侧的一个真 bug（见上文「Go 侧补齐的能力」第 13 条）：**工具的拒绝理由在跨进程边界上被整个丢掉**——模型看到的是一句通用话术 `Tool returned an invalid content result`，而不是拒绝它的理由。
- **Batch 23（已完成）**：图生命周期：闸门与公开模块输入。`tests/e2e/go-graph-lifecycle.test.ts`（2 条）移植 `tests/e2e/graph-lifecycle.test.ts` 的两条契约，走会话面那条路径（主 Agent 用 `graph_create` / `graph_send` / `graph_inspect` / `graph_patch` 驱动图，闸门动作走 daemon 自己的 `POST /api/tasks/{taskId}/graph/control`，因此拒绝是按 daemon 自己的错误码读的，不是模型转述的）：
  - **被挡住的完成一直关着，直到有人撤回**（第 1 条，两个变体：stopped 与 completed）：节点被停住时，图的完成请求把图推进 `completing` 并**立刻**关上外面的入口——外面再送值（`is completing; external delivery is closed`）与再送聊天（`is completing; execution-triggering chat is closed`）都被拒，而且模型读到的是**理由**而不是一句通用话术。显式 `withdraw_complete` 之后外面重新打开，队列回到那件等着的工作（`state: 'queued'`、`generation: 0`，还是同一件）。`stopped` 变体里停图把排着的工作取消了（队列项 `done`、`reason: 'cancelled by stop'`）；`completed` 变体里撤回完成 → 取消那件工作 → 恢复节点 → 把输入交给模块 `gate` → 模块真的触发（`triggered: true`）→ 图落回 `completed`。
  - **终态的图拒绝每一个执行闸门**（第 1 条的后半）：图 ended 之后，八个执行闸门（`pause` / `resume` / `pause(nodeId)` / `resume(nodeId)` / `reopen(moduleId)` / `retry` / `skip` / `cancel`）逐个被拒，错误码是 daemon 自己的 `invalid_graph`，理由点名「Ended graph cannot change its execution controls」；`withdraw_complete` 也被拒；补丁同样开不了这张图（模型读到「Ended graph cannot be patched」）；这些拒绝**没有动过队列**（前后的队列读回完全一样）。只有已经 `completed` 的图还认第二次 `complete`。
  - **公开模块输入整体校验、报出真实溯源、外部完成关闸后自己排空**（第 2 条）：不符合协议的值被整体拒绝并**指名到字段**（`route.job/n`），模块的输入仍然是 missing、没有任何投递被接受；符合的值被接受，投递自报家门（`source: 'direct'`、`edgeId: null`、`fromEndpoint: 'main'`、`toEndpoint: 'route.job'`、`protocol: 'number'`、`value: {n: 7}`、`revisionVersion: 1`）；完成请求之后外面再送就被拒；图在它接受的那一笔上排空（结果 `[{value: {n: 7}}]`、相位 `completed`），`graph.delivery.accepted` 事件**只有一条**。
  - 这一批逼出了 Go 侧的一个真 bug（见上文「Go 侧补齐的能力」第 14 条）：**投递与补丁的结果读不出来**（两处都缺 JSON tag，模型看到的是 `Delivery` / `Revision`）。
- **Batch 24（已完成）**：图生命周期：局部补丁的路由与修订、字面节点 id。两条都是 Go 侧自有的契约（不在 101 条孤儿清单里），走会话面那条路径（主 Agent 用 `graph_create` / `graph_send` / `graph_inspect` / `graph_patch` 驱动图，闸门动作走 daemon 自己的 `POST /api/tasks/{taskId}/graph/control`）：
  - **补丁落地在提交之前，就改那次提交的路由**（`tests/e2e/go-graph-patch.test.ts`）：节点 a 正在干活时把连接 `link` 关掉（修订 2），随后到达的提交**没有**送到节点 b（`link` 上没有任何投递，b 连一次回合都没被问过）；把连接重新打开（修订 3）再送一次输入，这次提交**真的**到了 b（投递 `value: {n: 7}`，接收端 `queued`）。这正是独立验收报告 F5 记的那条「动态禁用边不影响当前执行随后发生的首次提交」——Go 侧按**当前修订**取连接集合，这条契约现在被真实 E2E 钉住。
  - **补丁的边界与它不动 revision 的证据**：基于过期修订（`baseRevision: 3`，当前已是 4）的补丁什么也不改，模型读到的是「current revision is 4」；同时给全量定义与局部 patch（`Supply exactly one full definition or local patch`）、patch 不是 JSON 对象（`Graph patch must be a JSON object`）、引用未知协议三种坏补丁各自被拒，且三者的修订号与被拒之前完全一样。
  - **已受理的活在删边之后仍然活着**：还有工作在排队时删掉节点 b 被拒（`Cannot remove b`），b 的实例 id 不变；工作跑完之后再明确 `retire`，节点状态是 `retired`、实例 id 不变、历史条目一模一样，图落在补丁发布的那一版（修订 5）。
  - **节点 id 是字面文本**（`tests/e2e/go-graph-node-identity.test.ts`）：四个节点 id 分别是 `plain` / `bracket[1]` / `star*` / `question?`——正是通配符会吃掉的那些字符。四张图各自建起来、各自被投递、各自跑起来（daemon 侧的执行 id 是 `exec-…-bracket[1]-2`、`exec-…-star*-3`、`exec-…-question?-4`），节点 id 一个都没有被当成模式；控制面按 nodeId 精确匹配，错的节点被拒、对的节点被接受。
  - **已经提交过的产出不能再被重试花掉一遍**：节点先失败一次（没交出产出），重试让它交了产出、但它承诺的交付物始终没写出来，于是这一代仍是 `failed`（`generation: 1`，理由是「…was never written」）；此时它**已经交出去的值仍然在图上**（`results` 里能读回 `{marker: <节点 id>}`）；再对同一件工作 `retry`，daemon 用自己的错误码拒绝（`invalid_queue`、「Submitted work cannot be sent again」）；只有显式 `skip` 掉这件失败的工作，图才落回 `completed`。
  - 这一批**没有**逼出 Go 侧的真 bug：两条契约在 Go 侧本来就成立，补的是证明。
- **Batch 25（已完成）**：图定义：拒绝面与协议值。`tests/e2e/go-graph-definitions.test.ts`（2 条），走会话面那条路径（主 Agent 用 `graph_create` / `graph_send` / `graph_inspect` 驱动图）：
  - **坏定义逐条被点名，且不留半张图**（第 1 条）：五十四条坏定义——节点声明宿主命令、图输入指向不存在的端点、工作位置越界或基底未知、访问策略字段写错或没有 mode、边的启用位不是布尔、边指向不存在的端点、边两端协议版本不一致、边 id 是空白、schemaVersion 不支持、输出引用未声明的协议、提交要求未声明的产出、模型/重试/指令写错、执行默认值写错、验收项写错、协议 schema 非法、以及四种遗留字段（`context` / `dependsOn` / `when` / `container`）——每一条都被 daemon 用**自己的话**拒掉并点名那条规则（`Node worker is an agent; declare host commands in an operation module`、`Edge link enabled must be an explicit boolean`、`Graph defaults budget.tokens must be a non-negative integer or null`、`Acceptance a must name an agent reviewer`、`Protocol bad has an invalid schema: ...`、`Node worker has unsupported field context`…），**没有一张图被创建**（任务列表里一个都没有），**没有一个节点被问过**。
  - **协议真的约束值，好值原样通过**（第 2 条）：协议声明了 `enum` / `minItems` / `items.minimum` / `additionalProperties: false`，于是四个坏值（枚举外的状态、空数组、元素为 0、多一个字段）**在值落地前就被拒**（理由指名到字段：`worker.job/status: must be equal to one of the allowed values`、`worker.job/items: must NOT have fewer than 1 items`、`worker.job/items/0: must be >= 1`、`worker.job: must NOT have additional properties`），队列里一件工作都没有、节点一次也没被问；合规的值原样进了节点、节点把它原样交回来（图上的结果是 `{status: 'approved', items: [1]}`），图落回 `completed`。
  - 这一批逼出了 Go 侧的三个真 bug（见上文「Go 侧补齐的能力」第 15、16、17 条）：**显式的 null 被当成没写**（`model: null` 这类定义被真的建成了图）、**没写额度的预算被当成不限额**、**协议 schema 只认六个关键字**（声明了严格协议的图收任何值都收）。
- **Batch 26（已完成）**：图模块与产物发布。`tests/e2e/go-graph-modules.test.ts`（3 条）搬进 `tests/e2e/graph-modules.test.ts` 的三条契约，`tests/e2e/go-artifact-publication.test.ts`（2 条）搬进 `tests/e2e/artifact-publication.test.ts` 的两条契约，同样走会话面那条路径：
  - **每个路由都级联过去，值保持顺序，被关掉的边什么也不带**（模块第 1 条）：两个路由模块串成一条链（`gate.rework → second.review`），一个没匹配任何规则的值**一件工作都没变成**（队列是空的，节点一次也没被问）；两个匹配上的值按顺序排在队列上；`gate.rework` 这条边上真的有一笔 `source: 'module'` 的投递，关掉的 `off` 边上**一笔都没有**；级联进去的 `second` 模块确实收到了那个值；模块的每一次判断都说出了自己匹配的是哪条规则（`no rule matched` / `review.passed == false` / `review.passed == true`，规则版本都是 1）；节点后来被问了两次，一次一个值。
  - **规则表达式读值、分辨「有」与「没有」、按声明顺序合并输出**（模块第 2 条）：十五条表达式逐条被钉住——`$exists` / `$missing`、字段比较（`==` / `>` / `>=`）、字符串比较、复合条件（`&&` / `||` / `!`）、以及一条指向不存在字段的规则（不匹配）。每条规则要么产出了 `{marker: 'matched'}`，要么什么都没有，两边都按它该有的样子被证明。
  - **once 模块保留它握住的输入，只有被重新打开才再判断一次，输出从不重放**（模块第 3 条）：只到一个输入时模块**在等**（结果为空）；两个都到齐才判断一次并把两者配对；闩住之后再来输入**不再判断**（结果还是一条）；模块握着**更新过**的输入值；显式 `reopen` 只清闩、不判断、也不产出；之后的一次投递才让它再判断一次，用的是它握住的最新值；送进去的控制输入同样只重开、不产出（控制输入在模块视图里 `delivered: false`）；再下一次投递才产生第三条结果。
  - **发布出去的是不可变的一个版本，过期的 compare-and-swap 被拒，同一个请求只发布一次**（产物第 1 条）：三种坏发布各自被指名（`schema must use kind@version syntax`、`must be a label`、`lowercase slug`）；第一次发布是版本 1，同一个 `requestId` 再发一次**仍然是版本 1**（不是两次发布）；接着是版本 2；一个还指望版本 1 的发布被拒（`Artifact head changed`）；文档只有一个头，停在版本 2，标签被规范化（`Known-Issue` → `known-issue`，中文标签原样保留），schema 记着 `source-list@1`；两个版本都读得回来，各自的字节没变；被拒的那次发布什么也没留下。
  - **越出工作副本的路径与符号链接都被拒，宿主字节一个字节都没回给模型**（产物第 2 条）：`../host-only.txt` 被拒（理由点名 `work copy`），指向它的符号链接被拒（`may not be a symbolic link`），宿主文件的内容**从未出现在模型的任何一次请求里**，也没有任何产物被发布。
  - 这一批**没有**逼出 Go 侧的真 bug：模块与产物这两套语义在 Go 侧本来就成立，补的是证明。
- **Batch 27（已完成）**：图确认。`tests/e2e/go-graph-confirmation.test.ts`（2 条）搬进 `tests/e2e/graph-confirmation.test.ts` 的两条契约（W5 确认一个带 v2 定义的草稿会变成一张真跑得起来的图；W6 旧形状的草稿变不成功能任务）。这一簇走的是**会话面**那条路径：主 Agent 用 `propose_graph` 提案，用户在 HTTP 上确认，确认创建的功能任务再由主 Agent 用 `graph_send` 投递、节点真的跑起来：
  - **确认后的图真的跑起来了**（第 1 条）：主 Agent 提出的草稿**是一份画得出来的文档**——`GET /api/conversations/{id}/draft-graph` 给出三个节点（`a` / `b` / `gate`）、模块节点的 `kind: 'module'` 与 `action: 'route'`、一条 `a → b` 的布局边、以及一条 `a.out → b.in`、协议 `ping`、还没有投递的接口。用户确认（`POST /api/conversations/{id}/confirm`）后创建的功能任务是**同一份文档**：节点一样、布局边一样、接口一样，节点都等着（`status: 'idle'`），**什么都没跑**——直到有输入投递进去。主 Agent 醒来后的那次投递**落在命名输入上**（`a.in`，值 `{n: 0}`，状态 `accepted`），并排成一件要干的活（队列 `queued`）；链真的走通：`a` 与 `b` 各自完成，`a` 交回来的 `{n: 42}` 真的顺着 `ab` 那条边送到了 `b`。**同一个草稿确认两次不会叫醒 master 两次**。
  - **旧形状的草案变不成功能**（第 2 条）：旧形提案被 daemon **用工具自己的 schema 校验**拒掉，并点名缺了哪个字段（`Validation failed for tool "propose_graph": - proposal.definition: must have required properties definition`）；确认接口回 **400 `stale_proposal`**（没有可确认的当前草稿）；**没有产生任何功能任务**（任务列表里没有那条请求）。
  - 这一批逼出了 Go 侧的一个真 bug（见上文「Go 侧补齐的能力」第 18 条）：**会话的草稿图永远是空的**——`serveDraftGraph` 把提案的 `spec` 按 `map[string]any` 断言，而它是 `NativeProposal` 结构体，断言失败后草稿被画成空图。回退这个修复后，用例在草稿视图这一句上变红（`expected [] to deeply equal [ 'a', 'b', 'gate' ]`），证明这条缺口是实的。
- **Batch 28（已完成）**：provider 目录与探针。`tests/e2e/go-provider-directory.test.ts`（4 条）搬进 `tests/e2e/providers.test.ts` 里**还没有被别的 Go 用例覆盖**的那条契约（该文件另外两条——「保存的请求头与凭据可用性到达真实会话」与「view 模式下建的任务在下次 execute 启动时恢复且不派发被移出的项目」——分别已由 `tests/e2e/go-provider-headers.test.ts`（4 条）与 `tests/e2e/go-startup.test.ts` / `tests/e2e/go-removed-project.test.ts` 覆盖）：
  - **目录说清了可以配什么，而且一个密钥都不给**（第 1 条）：目录点名了每一个内置厂商（`opencode-go` / `command-goat` / `grok` / `chatgpt` / `deepseek` / `custom`），每个厂商都说得出**自己要哪个环境变量**（`grok` 要 `GRAPH_SUBSCRIPTION_GROK_ACCESS_TOKEN`、`opencode-go` 要 `GRAPH_SUBSCRIPTION_OPENCODE_GO_API_KEY`）以及**能不能列模型**；**凭据在环境里就是「已配置」，不在就不是**（`deepseek` 已配置 / `grok` 没配置）；配置里声明的凭据按名字显示，连同它的并发限额（`credentials: { local: 2 }` / `sharedGroups: { team: 4 }`）；**密钥值一次也没出现**在回答里；**没有会话 cookie 的调用是 401**，`/api/app/*` 是 403（桌面桥接要令牌）。
  - **探针说厂商自己的协议**（第 2 条）：先列模型、再发一次最小的对话请求证明凭据能用，两次都带着密钥而**回答里没有密钥**；厂商用别的形状列模型也读得懂（`['a', {model:'b',display_name:'Bee'}]` → `[{id:'a'},{id:'b',name:'Bee'}]`、`[{slug:'c'}]` → `[{id:'c'}]`、`{}` → `[]`）；**Anthropic 协议就是另一套协议**——`x-api-key` + `anthropic-version: 2023-06-01`、路径 `/v1/messages`、请求体 `{model, max_tokens: 1, messages:[{role:'user',content:'ping'}]}`，**一个 bearer token 都不带**；目录里「这个厂商不能列模型」那一条只是建议，**真的照问**；`probeModels: false` 时只发那一次对话请求。
  - **厂商拒绝时保留它自己的话**（第 3 条）：403 / 429 带 `error.message` 时原样透出（`subscription does not allow listing`、`Rate limit reached`），没有消息体的 503 说 `HTTP 503`；**不是 JSON 的响应体也原样透出**（`upstream unavailable`、`quota exceeded`、`invalid model`）；**凭据解析不出来时点名那个环境变量**、回 `credentialConfigured: false`，而且**发出去的请求不带任何 authorization**；端点根本不在时是一次**失败的验证**（`ok: false`、`status: 0`），不是崩溃。
  - **坏草稿按字段被拒，而且一个请求都没发出去**（第 4 条）：缺 `requestId`、空 `requestId`、自定义厂商缺 `baseUrl` / `api` / `label`、`ftp://` 地址、`responses` 格式、缺厂商名、`credentialRef` 不是环境变量名、平台 id 不存在——每一条都回 **400 `invalid_input`** 并**点名那个字段**；**这些拒绝一次都没到达厂商**；扁平写法（字段不套 `provider`）照样认；没写 `credentialRef` 时用默认的 `GRAPH_PROVIDER_API_KEY`（而它并不在环境里，于是 `credentialConfigured: false`）。
  - 这一批逼出了 Go 侧的一个真 bug（见上文「Go 侧补齐的能力」第 19 条）：**任何合法的 provider 地址都被判为非法**——`isHttpURL` 把 Go 的 `url.URL.Scheme`（不带冒号）拿去和 `"http:"` 比，于是探针面整条路都只会回 400。回退这个修复后，第 2、3、4 条用例全部变红（`baseUrl: Base URL 必须是 http(s) 绝对地址`），证明这条缺口是实的。
- **Batch 29（已完成）**：目录面与密钥桥接。`tests/e2e/go-catalog-tools.test.ts`（2 条）搬进 `tests/e2e/catalog-tool-loading.test.ts` 的那条契约（目录面按需装载、装载之后真的执行、重启之后仍然可用），`tests/e2e/go-secret-lifecycle.test.ts`（1 条）搬进 `tests/e2e/secret-lifecycle.test.ts` 的整条契约：
  - **目录面按需装载，装载之后真的执行，重启之后仍然可用**（第 1 条）：目录面默认是**延迟装载**的（`GRAPH_DEFER_CATALOG_TOOLS=1`），所以**第一次请求里给的是装载工具**（`load_catalog_tools`），目录本身（`list_agent_combinations` / `get_agent_combination`）**不在**这一次的工具表里；装载工具真的跑了（结果点名了 `list_agent_combinations`），**下一次请求的工具表里目录才出现**（而且 `get_agent_combination` 也在）；目录工具真的执行了：`list_agent_combinations` 回的是 `{total, items}`，里面真的有 `main` 这条配方；`get_agent_combination` 回的是那条配方本身（`mode: 'main'`、`recommendedGrade: 'high'`、名字非空）；**回答里没有一句「工具找不到 / 工具不可用 / 参数校验失败」**。**daemon 重启之后**（同一个状态目录、同一个会话）目录**仍然是绑定着的**，而且照样答得出真实配方。
  - **不带参数的工具照样跑得起来**（第 2 条）：`list_projects` 这种**一个参数都不吃**的工具，它的调用带的是一个**空参数对象**（`{}`）——而 Go 的内容块把参数那一份字段标了 `omitempty`，**空对象整个被丢掉**，worker 侧的 SDK 立刻判这次调用非法（`Validation failed for tool "list_projects": - root: must be object / Received arguments: undefined`）。修完之后，这次调用真的执行了：回的是 daemon **自己**配置里的那个项目（`id: 'p'`、root 指向那个项目目录），不是一句拒绝。
  - **特权密钥桥接把最新的一次写入留到最后确认，浏览器看不到值**（第 3 条）：桥接令牌写在 daemon 自己的状态目录里（`<state-dir>/app-token`），**浏览器拿着会话 cookie 也进不去**（`/api/app/secret-requests` 是 403）；宿主请求的一次写入**等着桌面端去存**（`pendingSecretRefs` 点名那个引用），**最新的写入才是算数的那一次**（旧的确认回来是**过期的**，理由是 `持久化确认已过期`，新的值继续等着）；浏览器看到的是「有一个密钥待确认」，**永远看不到值**（回答里与配置文件里都没有那个值）；桌面端确认之后就没有待办的了。**登出是一次删除**，它同样等桌面端：登出之后 `configured` 变成 `false`。**迟到的确认不许把密钥复活**——旧写者可能已经把值存到磁盘上了，于是删除被**重新排队**，密钥没有回来。最后，**没人声明的那个引用不会被排给桌面端**。
  - 顺带把 `tests/e2e/go-rsi-apply.test.ts` 里标量参数那条断言**收紧**：模型发错的参数必须**原样展示**回模型（`Received arguments` 里要看得见那个标量），而不是先被改写成一个空对象、再报一个对不上的错。回退第 22 条那个修复后，这条用例在 `toContain('not an object')` 上变红。
  - 这一批逼出了 Go 侧的三个真 bug（见上文「Go 侧补齐的能力」第 20、21、22 条）：**不带参数的工具整个调不动**（空参数对象被 `omitempty` 丢掉，SDK 判它非法），**撤销之后的迟到确认会把密钥复活**（把「已撤销」误当成「没有当前值」，于是不判过期也不重排删除），**模型发错的参数被悄悄改写成空对象**（于是模型收到的反馈与它真正写错的地方对不上）。
- **Batch 30（已完成）**：无可用凭据时的「拒绝并给出原因」。`tests/e2e/go-credential-refusal.test.ts`（2 条）：一条补上 `tests/m8/credentials.test.ts` 里那条还没被 Go 覆盖的契约（**没有可解析凭据的模型在发出任何请求之前就被拒**），一条把 2026-10-21 定夺的「拒绝并给出原因」钉住：
  - **图节点自己的模型没有密钥 → 节点失败，原因就写在时间线上**（第 2 条）：主 Agent 建的图里有一个节点声明 `model: 'other'`，而 `'other'` **配了但没有密钥**（它的环境变量根本不在环境里）。那个节点**没有**被送到 provider（provider 收到的请求数是 0），节点的状态是 **`failed`**，时间线上有一条 **`graph.node.failed`**，它的 `reason` 点名了那个没有密钥的模型（`no credential bound`）。这一条在 Go 侧本来就是这样，**这一批补的是证明**。
  - **一个模型都叫不动的会话，被拒而且说清了原因，密钥回来就照跑**（第 1 条）：密钥先被真的撤销（走特权桥接），于是这条会话**没有 master 节点可跑**——修之前那条用户消息永远停在 `pending`，`master` 为 null，什么事件、什么问题、什么原因都没有，用户既看不到发生了什么也无从下手。修之后：**原因被说出来了**（系统错误消息里写着「主 Agent 本轮没有启动起来……原因：No credential bound for model local」），**消息被保留**（它从未被投递过，状态还是 `pending`），**provider 一个请求都没收到**。密钥回来之后（宿主请桌面端存，桌面端确认），**那条被保留的消息真的跑了**：master 出现了，消息变成 `delivered`，master 答了话，provider 收到 1 次请求。回退这个修复后，第 1 条用例在「系统错误消息出现」这一句上变红。
  - 这一批修掉了 Go 侧的一个真 bug（见上文「Go 侧补齐的能力」第 23 条）：**没有可用凭据时，用户的请求被无声地吞掉**。
- **Batch 31 起**：任务面（`POST /api/tasks`）的同一处缺口——任务在没有可用凭据时停在 `discussing`，同样没有原因；它需要另一个通道（任务没有会话消息，只有一个问题面）与它自己的恢复语义，列在下一批。以及 `read_system_capabilities` 的能力缺口、`harness-cost`、`recipe-compile`、`m8/app-shell-ux` 浏览器轨。
- **Batch 12 起**：按覆盖矩阵与孤儿契约清单逐条移植。孤儿清单里 101 条 `yes` 每条一条 Go E2E，按主题分簇（预算与用量 / 暂停 / 评审与验收 / 取数 / 内核存储 / 图生命周期 / 会话面 / 沉淀 / 自改进），每簇一个文件。
- **收尾**：迁移或退休 `scripts/`、`examples/` 里的 TS 工具，删除 102 个模块，更新 `package.json`、`tsconfig.json`、门禁与文档。

## 门禁与纪律

- 只允许新增或改写真正的 E2E：真实浏览器、HTTP、CLI 或公开运行时，真实持久化与副作用。禁止单元/集成测试。
- Go E2E 的夹具是 `tests/helpers/cli-daemon.ts` 的 `launchCli`（真实 `graphd` 二进制）与 `tests/fixtures/openai-server.ts`（受控模型服务）。自有协作者的回执、顺序与状态必须由真实 owner 产生。
- 退役旧测试前先证明新 keeper 通过；负向断言先证明目标元素、请求或 guard 存在。
- 每次提交前运行 `node --run check`。
