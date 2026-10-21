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
- **codemode**：内核内置 `codemode` 与 `tool_search`，**默认开启**，由 Graph 按需显式关闭（`codemode.enabled: false`）；不改变既有工具准入与沙箱策略——沙箱改变的是调用怎么写，不是调用准不准。
- **pi 扩展模型**：PiG 的扩展宿主在 `coding` 层（`coding/extension/host/subprocess`，自带内嵌 Node 运行时），durable 层没有到它的桥，因此**承载通道由 daemon 侧接**（`backend/internal/pigkernel/extensions.go`、`backend/internal/graph/runtime_pig_extensions.go`）：daemon 起扩展宿主，把扩展的工具体注册进 durable harness，并在调用前后投递扩展的 `tool_call`/`tool_result` hook。Graph 侧受控的 hook 是 **15 个**（`resources_discover`、`session_tree`、`input`、`session_start`、`session_shutdown`、`before_agent_start`、`agent_start`、`agent_end`、`turn_start`、`turn_end`、`message_start`、`message_update`、`message_end`、`tool_call`、`tool_result`），另有仅注册的 `session_checkpoint`；此前文档写的"17 类"从代码复现不出，以这 15(+1) 为准。与 PiG 侧的对应能力已逐条核对，结论见下方实施状态。
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
- **codemode 已接入，默认开启**（`backend/internal/graph/runtime_pig_codemode.go`）。内核自带的 QuickJS 沙箱由 daemon 供主机侧：脚本能调用的就是该会话自己的工具，每一次调用仍走同一道准入闸门——沙箱改变的是调用怎么写，不是调用准不准。Graph **默认提供**这个工具，`graph.config.json` 的 `codemode.enabled: false` 才把它关掉（要模型逐个调工具的部署用得上）。默认值同时到达主 Agent 会话与图节点泳道。E2E `tests/e2e/pig-codemode.test.ts` 用真实 daemon、真实 provider 与真实宿主工具证明：配置里**不写** codemode 时模型照样收到 `codemode` 声明 → 调用它 → 脚本在沙箱里调用宿主的 `write` 工具 → 文件落在工作副本 → 答复带回脚本看到的内容；另一个用例证明显式关掉时模型根本看不到这个工具。`tests/e2e/pig-node-lane.test.ts` 另证节点泳道的那一回合同样带着沙箱。
- **默认内核已翻到 PiG**（`backend/internal/graph/server_cli.go`、`runtime_pig_session.go`）。不带 `--kernel` 启动的 daemon 直接在 Go 进程内跑 PiG 内核，不再拉起 TypeScript 侧车。E2E `tests/e2e/pig-default-kernel.test.ts` 用真实 daemon 证明：默认路径下**没有启动任何侧车进程**，且回合真的跑在 PiG 内核上（durable schema 版本 2、`graph_durable_conversations` 非空）。
- **会话提示词由 daemon 拼装**（`backend/internal/graph/runtime_pig_instructions.go`）。TypeScript SDK 原本在宿主侧追加项目上下文、可用技能清单与工作目录三块；PiG 内核不自带环境，这三块改由 daemon 按同样的顺序与形状补齐，因此模型在两个内核上看到同样的提示词。技能加载器按 SDK 语义自建：跟随符号链接目录、按规范化路径去重、同名先到先得、跳过没有描述的技能、排除 `disable-model-invocation` 的技能。E2E `tests/e2e/agent-skills.test.ts` 覆盖主 Agent 与图 worker 两条路径上的技能块。
- **TypeScript 侧车已退役**（expand–contract 的 contract 段）。Go↔TS 的侧车协议层整体删除：协议客户端、侧车配置、侧车节点宿主、侧车的恢复与节点恢复共 6 个 Go 文件，加上承载 MCP 网关的 `runtime_mcp_adapter_bridge.go`（合计 7 个），以及 TS 侧的子进程入口 `src/runtime/durable-service.ts`。daemon 启动后不再有任何子进程承载 durable 命名空间，`--kernel node` 也不再是选择，而是**按名字报错**（"the TypeScript durable sidecar is retired: the PiG kernel is the only kernel"）——两个内核争用同一批表是必须拒绝的，而不是悄悄起一个。
  - 随之迁居的活路径类型没有跟着删：节点恢复的交接机制（`runtime_node_recovery.go`）、冻结记录的读取助手（`runtime_frozen_record.go`）、worker 配置与工具形状（`runtime_pi_worker_config.go`）、内核回执的结算（`core_operation_lifecycle.go`）都换到了不再提"durable sidecar"的名字下，因为 PiG 路径一直在用它们。
  - **TypeScript 守护进程本身保留**：`src/server`、`src/core/task-runtime.ts` 与 15 个 durable 运行时文件仍在，m8 套件仍覆盖它们。退役它属于另一件事，本决策不夹带。
- **内置 pi-mcp 扩展已删除**。`pi-mcp-adapter` 不再是依赖（`package.json` 与 `pnpm-lock.yaml` 一起清掉，连带 26 个包），运行时注册事件 `pi-mcp-adapter:runtime-register:v1` 与它带的网关工具 `mcp` 一起消失，能力包不再把 MCP 服务器交给扩展，插件 worker 不再注册服务器。**MCP 只有一条路：内核自己连服务器**，模型拿到的是服务器自己的 `mcp__<server>__<tool>` 名字。
  - **声明侧保留**：Graph 仍解析 MCP 能力声明（命令、参数、环境、url、header 与密钥解析），Go 侧 `runtime_mcp_adapter_server.go` 与 TS 侧 `mcp-adapter-server.ts` 都在；变的只是承载它的通道。TypeScript 守护进程因此没有 MCP 网关了——那条退路上的会话看不到 MCP 工具，这是删除扩展的直接后果。
  - E2E `tests/e2e/pig-mcp-session.test.ts` 两例：一例用真实 MCP 服务器与真实 provider 证明原生通道仍然通（模型直呼 `mcp__wordcount__word_count`，没有网关工具），另一例证明产品不再自带这个扩展（依赖不在 `package.json` 里，产品源码里没有那个注册事件）。
- **pi 扩展已由 PiG 真正承载，缺口在 Graph 侧的接线（已接）**。逐条比对的结果：PiG 对 Pi 1.3.0 的扩展 API 有完整对等矩阵（`docs/extension-api-parity.md`），Graph 需要的 15 个 hook 全部 `wired`/`complete`，`tool_call` 可拦截与终止、`tool_result` 可改写内容，对应 Graph 的 `beforeTool`/`afterTool`；`message_start`/`message_update` 在 PiG 侧标 `partial`（PiG 自己的 D82：跨进程的部分消息观察差异）。Node 扩展走"Pi 兼容 default export"，结构上能承载 Graph 现有的 TS 扩展。**承载通道在 Graph 侧接上**：daemon 用 PiG 自己的子进程扩展宿主（自带内嵌 Node 运行时，无需外部 node）跑扩展，扩展的工具体注册进 durable harness，扩展的 `tool_call`/`tool_result` hook 由 daemon 在调用前后投递。
  - **扩展只拥有工具体，不拥有调用权**：扩展的工具与 Graph 自有工具走同一道准入闸门（`piWorkerGatedTool`），能力清单 `capability.json` 声明了哪些工具、这次会话允许调用哪些工具，两道都过了才出现在模型的工具表里。扩展的 hook 还能再拒一次——那是扩展自己的决定，Graph 尊重它。
  - **内核侧不再拒绝**：`backend/internal/pigkernel/session.go` 里那份"内核不承载 pi 扩展"的拒绝与 `ExtensionPaths` 已删除。durable 会话不承载扩展，扩展由 daemon 侧的常驻宿主承载（`sync.OnceValue`，扩展只加载一次，所有会话共用），避免两套并存的机制。
  - **依赖代价**：PiG 的扩展宿主在 `coding` 层，导入它会把 coding/TUI 那一层带进 daemon 二进制，`go mod tidy` 因此多出 11 个 indirect 模块（BurntSushi/toml、go-winio、charmbracelet/x/ansi、displaywidth、regexp2、fsnotify、flock、go-colorful、runewidth、golang.org/x/mod、golang.org/x/term）。这是"真承载"的账单，记在这里以免日后被当成意外。
  - **一处已知偏差**：扩展的 `tool_call`/`tool_result` 事件里的 `toolCallId` 是 Graph 为这次调用生成的 id，不是 transcript 里模型那次调用的 id（内核的工具契约不把模型调用 id 交给工具体）。两个事件之间是一致的，因此扩展能自己对上；只是它与模型看到的 id 不同。
  - **OS 沙箱的缺口，必须说清**：Graph 的 TypeScript 侧原本用 `@anthropic-ai/sandbox-runtime`（macOS `sandbox-exec`）限制扩展进程的文件读写与网络域；**PiG 的 node 扩展进程没有这层**，它拿到的是 daemon 自己的可达范围。因此规则是：**只有当会话策略与 daemon 自身可达范围一样宽**（`Filesystem.Read/Write == "host"` 且 `Network == "unrestricted"`，默认策略即如此）才允许承载扩展；否则**按名拒绝**（`setupError` 回合失败、模型一次不被问），不静默放宽。给 node 扩展进程补一层 OS 沙箱是独立后续工作。
  - E2E `tests/e2e/pig-pi-extension.test.ts` 三例：①真实 pi 扩展能力、真实绑定、真实 daemon——模型被 offer 扩展注册的 `proof_tool`，调用真的抵达扩展进程（扩展自己写的标记文件存在），扩展自己的回答（`extension-proof`）就是模型读到的；②扩展的 `tool_call` hook 返回 `{block: true, reason}` 拒绝调用，模型读到拒绝理由，而工具体**一次都没跑**（标记文件不存在）；③窄策略（`access.mode: standard`）的会话按名拒绝——模型一次没被问，错误消息点名 `proof@1.0.0`，问题以 `execution_failed` 交给 main。
  - E2E `tests/e2e/pig-node-pi-extension.test.ts`：图节点那条路径——节点的配方绑定 pi 扩展，节点在自己的内核回合里真的调用了扩展的工具，扩展的进程写了它自己的文件，节点读到了扩展的回答，然后 `submit`。

节点泳道的崩溃恢复是最后一关口，已经补齐：节点的**活路径**与**恢复路径**都已在 PiG 内核上。崩溃恢复把该节点执行置为 `blocked`（与 TS 路径同一步）之后，PiG 路径按主 Agent 那套三分法继续——已受理未发出的用受理时的配置重发，已经到过模型的不重放，内核那一回合被停掉以免被调度器顺手再驱动一次。产品层面的关口同样过了：默认内核翻了过去，TypeScript 侧车与 `pi-mcp-adapter` 扩展随之删除。

pi 扩展这条线也过了第二关：承载通道接上了——daemon 用 PiG 自己的子进程扩展宿主跑 TS pi 扩展，扩展的工具真的能被模型调用，扩展的 hook 真的能拦住调用，窄策略的会话真的被按名拒绝。留下的缺口是 OS 沙箱：PiG 的 node 扩展进程没有 Graph 的 TS 侧那层 `sandbox-exec`，因此只有与 daemon 自身可达范围同宽的会话才允许承载扩展。

模型通道上还顺手修好一个真缺陷：daemon 自己的助手消息 JSON 会**省略**空参数工具调用的 `arguments`，内核读到的是 `null`，于是任何对象模式的工具都被参数校验拒掉（"root: must be object"）。桥接现在把缺省的参数补回空对象——一次没问过参数的调用是一次**空参数**的调用，不是**没有参数**的调用。这条修复对 Graph 自有工具同样成立（`tests/e2e/pig-pi-extension.test.ts` 是它的活证据）。

MCP 的产品级通道已证明可用：Graph 的能力目录里绑定一个真实 MCP 服务器，模型直接收到 `mcp__<server>__<tool>` 声明并直呼该工具，没有网关工具、没有扩展事件总线（E2E `tests/e2e/pig-mcp-session.test.ts`）。

仍在迁移收尾阶段的部分：TypeScript 守护进程本身（`src/server`、`src/core/task-runtime.ts` 与 15 个 durable 运行时文件，m8 套件覆盖）的退役；给 node 扩展进程补一层 OS 沙箱（等价于 TS 侧的 `sandbox-exec`）；以及 Pi 1.1.0→1.3.0 的运行语义逐条核对。

## 与既有决策的冲突

本决策取代 ADR 0032 的"Node 辅助进程承载共享 durable Harness"实现选择；ADR 0032 中"Go 拥有 HTTP/SSE、业务状态、凭据、准入与用量"的分工被保留并加强为"模型通道由 daemon 提供"。ADR 0006 关于 TypeScript 作为领域内核实现语言的选择，其内核部分由本决策取代；Web 与桌面壳仍为 TypeScript。
