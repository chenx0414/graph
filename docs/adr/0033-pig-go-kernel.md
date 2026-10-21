# ADR 0033：Graph 内核迁移至 PiG（Pi in Go）

2026-10-20。后端已迁至 Go，Agent 内核仍由 Node 侧车承载 TypeScript 的 `@earendil-works/pi-*` 1.1.0。使用者要求把内核换成 Go 版 Pi（PiG），并要求上游内核可一键更新。本决策采纳 [PiG](https://github.com/MichaelKinsy/PiG) 作为 durable 内核、MCP 通道与 codemode 的实现，MCP 不再走扩展。

## 依据

三项能力核对见 [调研](../research/pig-go-kernel-2026-10-20.md)：PiG 提供 `durable/`（`@earendil-works/pi-durable` 的逐文件移植，含 `durable/harness`、`durable/storage/sqlite`）、`mcp/`（stdio 与可流式 HTTP，含 OAuth）与 `codemode/`（QuickJS/wazero），且作为 Go 模块可在本机 Go 1.27.1 上编译通过。

## 对既有决策的影响

取代 ADR 0032 中"每个正式 SQLite 数据库由一个 Node 辅助进程承载共享 durable Harness"的实现选择：宿主改为 Go 进程内的 PiG durable harness。保留 ADR 0031 的共享 durable 执行规则、ADR 0030 的接口投递模型，以及 ADR 0032 中"Go 拥有 HTTP/SSE、业务状态、凭据、准入与用量"的分工。ADR 0006 关于 TypeScript 作为领域内核实现语言的选择，其内核部分由本决策取代；Web 与桌面壳仍为 TypeScript。

## 实施边界

- **同一份数据**：durable 表继续使用正式数据库中的 `graph_durable_` 命名空间。PiG 的 SQLite 端口原生支持表前缀（`CreateSqliteSchema`），因此 Go 宿主直接接管同一批物理表，不需要 TS 侧那层 SQL 词法改写。
- **同一份协议**：Go 侧与宿主的 Unix socket 行协议保持不变，宿主实现可先以 Go 替换 Node 侧车，再逐段替换行为；协议不变使切换可回退。
- **凭据留在 Go**：模型凭据、准入、用量账本继续留在 Go 进程；内核不得新增绕过权限或预算的模型请求通道。
- **MCP 走原生通道**：删除内置 `pi-mcp-adapter` 扩展及其运行时注册事件 `pi-mcp-adapter:runtime-register:v1`，MCP 服务器由内核直接注册与连接；扩展退役前须确认节点绑定到 MCP 能力的语义由原生通道等价承接。
- **codemode**：内核内置 `codemode` 与 `tool_search`，默认关闭，由 Graph 按需显式启用，不改变既有工具准入与沙箱策略。
- **pi 扩展模型是未验证项**：PiG 的扩展是 Go/Rust/Python/Node 资源，与现有"沙箱内加载 TypeScript pi 扩展并暴露 tool/hook"形态不等价，17 类 hook 与 `beforeTool`/`afterTool` 拦截的对应能力需单独核对；在核对完成前不删除既有 TS 扩展路径。
- **版本落差**：PiG 钉住 Pi 1.3.0，Graph 钉住 Pi 1.1.0。durable schema 与运行语义差异必须由迁移与恢复验收证明，不能由"PiG 是移植"推定。

## 内核更新

PiG 以 Go 模块依赖引入，钉住版本记录在 `backend/go.mod`。更新由 `pnpm pig:update` 单命令完成：解析上游最新版本、写入钉住版本、整理依赖、重建后端并校验。更新不得静默改变运行中桌面应用的内核版本，切换仍需走既有验收。

## 实施状态（2026-10-21）

内核选择由 `graphd --kernel node|pig` 显式决定，**默认已是 `pig`**：daemon 默认在 Go 进程内跑 PiG 内核，不再启动 TypeScript 侧车。侧车随后连同承载它的协议层一起退役，`--kernel node` 现在按名字报错。

已落地并有 E2E 的部分：

- **主 Agent 常驻会话跑在 PiG 内核**（`backend/internal/pigkernel/session.go`、`backend/internal/graph/runtime_pig_session.go`）。内核进程内常驻，按身份寻址 durable 会话，装配方与工具，连原生 MCP，订阅内核事件。
- **模型通道仍归 daemon**（`backend/internal/pigkernel/provider.go`）。PiG 的 provider 运行时接受任意 stream 实现，因此 daemon 把自己那条受控流交给内核：内核向 daemon 要答案，daemon 决定是否放行、花哪把凭据、记哪笔用量。内核因此拿不到一条绕过准入或预算的 provider 通道。
- **原生工具由 daemon 提供**（`backend/internal/graph/runtime_pig_native_tools.go`）。TypeScript SDK 原本提供 read/write/edit/ls/find/grep 与 shell；PiG 内核不自带环境，这套工具在 Go 侧补齐，名字与声明与 SDK 一致，路径规则复用 Graph 既有的越界保护。
- **崩溃恢复由内核承担**（`backend/internal/pigkernel/recovery.go`、`backend/internal/graph/runtime_pig_recovery.go`）。daemon 崩溃后能恢复三种事实：
  - **内核已完成、Graph 未确认的回合**：内核的提交回执（`graph_durable_submissions` 中 `status='done'`）就是凭据，daemon 用它结算该操作，**不再问模型一次**。
  - **已受理但从未发出的输入**：用**受理时的配置**重发，而不是用目录里此刻的配置。冻结记录 `graph.frozen-executions` 保存模型、指令、工具与策略，凭据不落盘（只记下可复原的 header 名）。
  - **已经抵达模型的回合**：不重放。凭据已花、副作用可能已发生，该操作停在 `unknown`，交由用户核对。
  - **恢复的交接不得靠竞态**："已受理未发"那一路要把当时那份请求与输入交给真正的重发，因此交接用"捕获到的值"而不是"准备动作结束了"作为判据：两者同时就绪时 `select` 会随机挑一个，挑中"结束了"就会静默放弃这次恢复，让操作永远停在 `unknown`。值优先，放弃时必须留下痕迹（daemon 的错误流）。
- **两个内核不得同时写一份 durable 命名空间**：选 `pig` 时 daemon 不启动 TypeScript 侧车，需要侧车的路径显式报错，而不是静默争用同一批表。
- **图节点泳道已迁到 PiG 内核**（`backend/internal/graph/runtime_pig_node_host.go`）。节点与主 Agent 共享同一个内核与同一份 durable 命名空间，各有各的身份与 durable 会话。模型通道、工具执行与准入闸门仍归 daemon：节点的工具（Graph 工具、`submit`、daemon 自带的原生工具）都在 Go 进程里执行，节点的模型调用走 daemon 自己那条受控流。E2E `tests/e2e/pig-node-lane.test.ts` 证明一整条图跑完：提案 → 确认 → 派发 → 节点在自己的内核回合里 `submit`，且没有启动任何 TypeScript 侧车进程。
- **节点泳道的崩溃恢复已迁到 PiG 内核**（`backend/internal/graph/runtime_pig_node_recovery.go`）。节点的冻结执行与主 Agent 的冻结执行在同一份文档里，内核的提交回执也是同一份，因此三种事实按同一套判据分：
  - **内核已完成**：内核的回执是"那一回合还在"的凭据——Graph 用它标上这个执行已完成，把队列项放回 `queued`，节点带着同一次受理再跑一遍，内核交回它留着的答复，模型不再被问一次。（带提交的执行默认不允许重启，"已完成"这个标记就是那道证明；TypeScript 侧车路径用的是同一个标记，只是证明来自侧车，PiG 路径来自内核回执。）
  - **已受理但从未发出**：用**受理时的**配置重发。冻结记录被翻译成 lane 认识的形状，恢复进 lane，节点重跑时用的是它当初被受理的那份模型、策略与工作副本。
  - **已经抵达模型**：不重放。队列项置 `failed`（而不是放回 `queued`），节点停在 `blocked` 等用户核对；要再花一次凭据必须是用户显式的重试。内核那一回合不需要额外停掉：生成任务从自己的检查点续跑，模型已经收到过的请求不会被再要一次——这一点由主 Agent 那条既有 E2E 证明（同一个内核里"已到模型"的那一路没有被重发）。
  E2E `tests/e2e/pig-node-recovery.test.ts` 用真实 daemon、真实 provider 与真实图把三种事实各证一遍：已受理未发出的输入用**原来的** `max_tokens` 重发（宕机期间目录里的值被改过，恢复仍用旧的），provider 只被问一次，节点跑完；内核已完成的那一回合（Graph 的写入被真实 SQLite 触发器打断）恢复后节点跑完而 provider 一个请求都没多；宕机时已在模型上的那一路不被重发，队列项停在 `failed` 且理由要用户核对。
- **codemode 已接入，默认关闭**（`backend/internal/graph/runtime_pig_codemode.go`）。内核自带的 QuickJS 沙箱由 daemon 供主机侧：脚本能调用的就是该会话自己的工具，每一次调用仍走同一道准入闸门——沙箱改变的是调用怎么写，不是调用准不准。Graph 只在配置显式要求时提供这个工具（`graph.config.json` 的 `codemode.enabled`），没要求过的会话不会拿到沙箱。E2E `tests/e2e/pig-codemode.test.ts` 用真实 daemon、真实 provider 与真实宿主工具证明：模型收到 `codemode` 声明 → 调用它 → 脚本在沙箱里调用宿主的 `write` 工具 → 文件落在工作副本 → 答复带回脚本看到的内容；另一个用例证明没配置时模型根本看不到这个工具。
- **默认内核已翻到 PiG**（`backend/internal/graph/server_cli.go`、`runtime_pig_session.go`）。不带 `--kernel` 启动的 daemon 直接在 Go 进程内跑 PiG 内核，不再拉起 TypeScript 侧车。E2E `tests/e2e/pig-default-kernel.test.ts` 用真实 daemon 证明：默认路径下**没有启动任何侧车进程**，且回合真的跑在 PiG 内核上（durable schema 版本 2、`graph_durable_conversations` 非空）。
- **会话提示词由 daemon 拼装**（`backend/internal/graph/runtime_pig_instructions.go`）。TypeScript SDK 原本在宿主侧追加项目上下文、可用技能清单与工作目录三块；PiG 内核不自带环境，这三块改由 daemon 按同样的顺序与形状补齐，因此模型在两个内核上看到同样的提示词。技能加载器按 SDK 语义自建：跟随符号链接目录、按规范化路径去重、同名先到先得、跳过没有描述的技能、排除 `disable-model-invocation` 的技能。E2E `tests/e2e/agent-skills.test.ts` 覆盖主 Agent 与图 worker 两条路径上的技能块。
- **TypeScript 侧车已退役**（expand–contract 的 contract 段）。Go↔TS 的侧车协议层整体删除：协议客户端、侧车配置、侧车节点宿主、侧车的恢复与节点恢复共 6 个 Go 文件，加上承载 MCP 网关的 `runtime_mcp_adapter_bridge.go`（合计 7 个），以及 TS 侧的子进程入口 `src/runtime/durable-service.ts`。daemon 启动后不再有任何子进程承载 durable 命名空间，`--kernel node` 也不再是选择，而是**按名字报错**（"the TypeScript durable sidecar is retired: the PiG kernel is the only kernel"）——两个内核争用同一批表是必须拒绝的，而不是悄悄起一个。
  - 随之迁居的活路径类型没有跟着删：节点恢复的交接机制（`runtime_node_recovery.go`）、冻结记录的读取助手（`runtime_frozen_record.go`）、worker 配置与工具形状（`runtime_pi_worker_config.go`）、内核回执的结算（`core_operation_lifecycle.go`）都换到了不再提"durable sidecar"的名字下，因为 PiG 路径一直在用它们。
  - **TypeScript 守护进程本身保留**：`src/server`、`src/core/task-runtime.ts` 与 15 个 durable 运行时文件仍在，m8 套件仍覆盖它们。退役它属于另一件事，本决策不夹带。
- **内置 pi-mcp 扩展已删除**。`pi-mcp-adapter` 不再是依赖（`package.json` 与 `pnpm-lock.yaml` 一起清掉，连带 26 个包），运行时注册事件 `pi-mcp-adapter:runtime-register:v1` 与它带的网关工具 `mcp` 一起消失，能力包不再把 MCP 服务器交给扩展，插件 worker 不再注册服务器。**MCP 只有一条路：内核自己连服务器**，模型拿到的是服务器自己的 `mcp__<server>__<tool>` 名字。
  - **声明侧保留**：Graph 仍解析 MCP 能力声明（命令、参数、环境、url、header 与密钥解析），Go 侧 `runtime_mcp_adapter_server.go` 与 TS 侧 `mcp-adapter-server.ts` 都在；变的只是承载它的通道。TypeScript 守护进程因此没有 MCP 网关了——那条退路上的会话看不到 MCP 工具，这是删除扩展的直接后果。
  - E2E `tests/e2e/pig-mcp-session.test.ts` 两例：一例用真实 MCP 服务器与真实 provider 证明原生通道仍然通（模型直呼 `mcp__wordcount__word_count`，没有网关工具），另一例证明产品不再自带这个扩展（依赖不在 `package.json` 里，产品源码里没有那个注册事件）。

节点泳道的崩溃恢复是最后一关口，已经补齐：节点的**活路径**与**恢复路径**都已在 PiG 内核上。崩溃恢复把该节点执行置为 `blocked`（与 TS 路径同一步）之后，PiG 路径按主 Agent 那套三分法继续——已受理未发出的用受理时的配置重发，已经到过模型的不重放，内核那一回合被停掉以免被调度器顺手再驱动一次。产品层面的关口同样过了：默认内核翻了过去，TypeScript 侧车与 `pi-mcp-adapter` 扩展随之删除。

MCP 的产品级通道已证明可用：Graph 的能力目录里绑定一个真实 MCP 服务器，模型直接收到 `mcp__<server>__<tool>` 声明并直呼该工具，没有网关工具、没有扩展事件总线（E2E `tests/e2e/pig-mcp-session.test.ts`）。

仍在迁移收尾阶段的部分：TypeScript 守护进程本身（`src/server`、`src/core/task-runtime.ts` 与 15 个 durable 运行时文件，m8 套件覆盖）的退役，以及 PiG 扩展模型与既有 17 类 TS pi 扩展 hook 的等价性核对。

## 与既有决策的冲突

本决策取代 ADR 0032 的"Node 辅助进程承载共享 durable Harness"实现选择；ADR 0032 中"Go 拥有 HTTP/SSE、业务状态、凭据、准入与用量"的分工被保留并加强为"模型通道由 daemon 提供"。ADR 0006 关于 TypeScript 作为领域内核实现语言的选择，其内核部分由本决策取代；Web 与桌面壳仍为 TypeScript。
