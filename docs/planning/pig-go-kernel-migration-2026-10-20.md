# PiG 内核迁移计划与状态（2026-10-20）

目标：把 Graph 的 Agent 执行内核从 TypeScript 的 `@earendil-works/pi-*` 1.1.0 换成 Go 版 Pi（PiG），MCP 全部走内核原生通道，并让上游内核可以一键更新。分支 `feature/pig-go-kernel`，基线 main `e8f6784`。

决策与依据：[ADR 0033](../adr/0033-pig-go-kernel.md)、[三项能力核对](../research/pig-go-kernel-2026-10-20.md)。

## 已完成并有证据的部分

1. **三项能力核对**：PiG 有 durable（`durable/`，950 个 Go 文件，逐文件移植 `@earendil-works/pi-durable`）、有原生 MCP（`mcp/`，stdio 与可流式 HTTP，含 OAuth；`pig mcp add|list` 与 `mcp.json`）、有 codemode（`codemode/`，QuickJS/wazero，内置 `codemode` 与 `tool_search`）。三项均为肯定。
2. **内核依赖与更新机制**：`backend/go.mod` 钉住 `github.com/MichaelKinsy/PiG v0.5.1`；`pnpm pig:update` 解析上游最新版本、改写钉住、整理依赖、重建后端并校验，失败时回滚到原状态。E2E：`tests/e2e/pig-kernel-update.test.ts`（真实网络、真实 Go 编译、真实回滚）。
3. **数据接续已证明**：`backend/internal/pigkernel` 用 PiG 的 SQLite 端口直接接管正式数据库的 `graph_durable_` 命名空间（PiG 原生支持表前缀，不再需要 TS 侧那层 SQL 词法改写）。E2E：`tests/e2e/pig-kernel.test.ts` 证明 PiG 内核能按相同标识读出 daemon 写入的 durable 会话与条目，PiG 的迁移把 durable schema 从版本 1 升到 2，且不改动原记录。
4. **内核能跑真实回合已证明**：`backend/internal/pigkernel/turn.go` 用 PiG 的 `durable/harness` 装配会话：daemon 决定模型、凭据、工具与准入，内核执行 provider 调用与工具往返，并把身份映射、提交与条目写回同一命名空间。E2E 同文件第二例用真实 HTTP 模型服务跑完"模型调用 `read` 工具 → daemon 读文件 → 结果回到模型 → 最终答复"，并断言 transcript 与提交都在 Graph 数据库里。
5. **MCP 原生通道已证明**：`backend/internal/pigkernel/mcp.go` 用 PiG 的 `mcp` 客户端直连服务器（stdio 或可流式 HTTP），把服务器的工具按 PiG 原生命名 `mcp__<server>__<tool>` 注册为模型工具，调用直接走 MCP 协议。E2E `tests/e2e/pig-kernel-mcp.test.ts` 起了一个真实 stdio MCP 服务器：模型收到原生名的工具声明、发起调用、服务器作答、结果回到模型。Graph 既有的 MCP 声明（命令、参数、环境、url、header 与密钥解析）保持不变，只是换了承载它的通道。
6. **产品级常驻会话已落地**：daemon 现在可以用 PiG 内核承载主 Agent 的会话。`backend/internal/pigkernel/session.go` 是常驻会话层：内核进程内常驻、按身份寻址 durable 会话、装配方与工具、连原生 MCP、订阅内核事件；`backend/internal/pigkernel/provider.go` 是模型通道桥——内核向 daemon 要答案，daemon 用自己的受控流作答，因此准入闸门、凭据、预算与用量账本一分未减，内核也拿不到一条绕过准入的 provider 通道。`backend/internal/graph/runtime_pig_session.go` 实现 `graph.AgentSessionTransport`，把 Graph 工具、Graph MCP 声明与系统提示接到内核上。E2E `tests/e2e/pig-session.test.ts` 用真实 daemon、真实 provider、真实 Graph 工具证明：主 Agent 的会话确实跑在 PiG 内核上（durable schema 版本 2、身份文档保持旧内核的 `{conversations:{...}}` 形状、重启后同一 durable 会话续写），且**没有启动任何 TypeScript 侧车进程**。
7. **原生工具落到 Go**：TypeScript SDK 原本提供 read/write/edit/ls/find/grep 与 shell，PiG 内核不自带环境，因此 daemon 在 Go 侧补齐这套原生工具（`backend/internal/graph/runtime_pig_native_tools.go`），名字与声明与 SDK 一致，路径规则复用 Graph 既有的越界保护。
8. **MCP 产品级通道已端到端证明**：`tests/e2e/pig-mcp-session.test.ts` 用真实 daemon、真实 MCP stdio 服务器与真实 provider 走完整条链路——Graph 定义绑定 MCP 能力 → daemon 解析出服务器声明 → PiG 内核原生连接服务器 → 模型收到 `mcp__wordcount__word_count` 声明（**没有** `mcp` 网关工具）→ 模型直呼该工具 → 服务器经协议作答 → 结果回到模型 → 最终答复。同时断言 durable 记录由 PiG 内核写入（schema 版本 2）。
9. **崩溃恢复已移植到 PiG 内核**：`backend/internal/pigkernel/recovery.go` 持有冻结执行文档 `graph.frozen-executions`（与 TS 侧同形：冻结记录按 durable 会话存放，值是 JSON 字符串），`backend/internal/graph/runtime_pig_recovery.go` 是 daemon 侧的恢复引导。daemon 崩溃后按三种事实分别处理：
   - **内核已完成、Graph 未确认**（`graph_durable_submissions` 中 `status='done'`）：用内核的回执结算该操作，不再问模型一次。
   - **已受理但从未发出**：用**受理时的**配置重发（冻结记录保存模型、指令、工具与策略，凭据不落盘，只记下可复原的 header 名），内核按原 admission id 认出已受理的输入，不会第二次受理。
   - **已经抵达模型**：不重放，操作停在 `unknown` 交用户核对。
   E2E `tests/e2e/pig-durable-recovery.test.ts` 用真实 daemon、真实 provider 与真实 SQLite 触发器证明前两种与第三种：触发器让 Graph 的确认写入失败，内核仍完成回合，重启后 daemon 用回执结算且 provider 请求数不增加；另一个用例证明已受理未发出的输入用**原来的** `max_tokens` 重发（配置在宕机期间被改成 512，恢复仍用 256），而宕机时已在模型上的那一路既不重发也不结算、停在 `unknown`。
10. **图节点泳道已迁到 PiG 内核**：`backend/internal/graph/runtime_pig_node_host.go` 是节点在 PiG 内核上的宿主，`runtime_kernel_graph_lane.go` 的 `Host` 闭包按内核分叉。节点与主 Agent 共享同一个内核与同一份 durable 命名空间，但各有自己的身份、durable 会话与 transcript：节点按 `session.Binding.InstanceId` 寻址，准入 id 仍是 `<execution>:attempt:<n>`，因此一次重试是一次新受理、一次被中断的回合保住它自己的受理。模型通道仍是 daemon 的受控流（`nodeChannel` 把节点那条闸门、凭据、额度与 `provider.request_profile` 事件原样搬过去），工具体也仍在 daemon 侧执行：Graph 工具、`submit` 与 daemon 自带的原生工具都跑在 Go 进程里。E2E `tests/e2e/pig-node-lane.test.ts` 用真实 daemon、真实 provider 与真实图证明：主 Agent 提案 → 用户确认 → `graph_send` 派发 → 节点在自己的内核回合里跑完并 `submit`，节点自己的 durable 会话里有这次回合的 `done` 受理，节点 transcript 里有助手的答复与 `submit` 调用，且 daemon **没有启动任何 TypeScript 侧车进程**。
11. **codemode 已接入，默认开启**：`backend/internal/graph/runtime_pig_codemode.go` 把内核自带的 QuickJS 沙箱接到 daemon 的主机侧。模型写一段 JavaScript，脚本能调用的就是该会话自己的工具，每一次调用仍走同一道准入闸门（沙箱改变的是调用怎么写，不是调用准不准）；`submit` 这类宿主自己的工具不进沙箱，脚本也不能再起一个脚本。Graph **默认提供**这个工具，`graph.config.json` 的 `codemode.enabled: false` 才关掉——默认开启并不放宽准入，只是让模型多一种写法。默认值同时到达主 Agent 会话与图节点泳道。E2E `tests/e2e/pig-codemode.test.ts` 用真实 daemon、真实 provider 与真实宿主工具证明：配置里**不写** codemode 时模型照样收到 `codemode` 声明 → 调用它 → 脚本在沙箱里调用宿主的 `write` 工具 → 文件落在工作副本 → 答复带回脚本看到的内容；另一个用例证明显式关掉时模型看不到这个工具。`tests/e2e/pig-node-lane.test.ts` 另证节点泳道的那一回合同样带着沙箱。
12. **节点泳道的崩溃恢复已移植**：`backend/internal/graph/runtime_pig_node_recovery.go` 把主 Agent 那套三分法接到图节点上。节点的冻结执行与主 Agent 的冻结执行在同一份文档里，内核的提交回执也是同一份，因此三种事实按同一套判据分：
   - **内核已完成**：内核的回执是"那一回合还在"的凭据。Graph 用它标上这个执行已完成（带提交的执行默认不允许重启，这个标记就是那道证明；TS 侧车路径用的是同一个标记，证明来自侧车，PiG 路径来自内核回执），把队列项放回 `queued`，节点带着同一次受理再跑一遍，内核交回它留着的答复，模型不再被问一次。
   - **已受理但从未发出**：用**受理时的**配置重发——冻结记录被翻译成 lane 认识的形状，恢复进 lane，节点重跑时用的是它当初被受理的那份模型、策略与工作副本。
   - **已经抵达模型**：不重放。队列项置 `failed`（而不是放回 `queued`），节点停在 `blocked` 等用户核对；要再花一次凭据必须是用户显式的重试。内核那一回合不需要额外停掉：生成任务从自己的检查点续跑，模型已经收到过的请求不会被再要一次——这一点由主 Agent 那条既有 E2E 证明（同一个内核里"已到模型"的那一路没有被重发）。
   E2E `tests/e2e/pig-node-recovery.test.ts` 用真实 daemon、真实 provider 与真实图把三种事实各证一遍：已受理未发出的输入用**原来的** `max_tokens` 重发（宕机期间目录里的 `max_tokens` 被改过，恢复仍用旧的），provider 只被问一次，节点跑完；内核已完成的那一回合（Graph 的写入被真实 SQLite 触发器打断）恢复后节点跑完而 provider 一个请求都没多；宕机时已在模型上的那一路不被重发，队列项停在 `failed` 且理由要用户核对。
13. **默认内核已翻到 PiG**：不带 `--kernel` 启动的 daemon 直接在 Go 进程内跑 PiG 内核（`backend/internal/graph/server_cli.go`、`runtime_pig_session.go`），不再拉起 TypeScript 侧车。E2E `tests/e2e/pig-default-kernel.test.ts` 用真实 daemon 证明默认路径下**没有启动任何侧车进程**且回合真的跑在 PiG 内核上（durable schema 版本 2、`graph_durable_conversations` 非空）。
14. **会话提示词由 daemon 拼装**：TypeScript SDK 原本在宿主侧追加项目上下文、可用技能清单与工作目录三块；PiG 内核不自带环境，这三块改由 daemon 按同样的顺序与形状补齐（`backend/internal/graph/runtime_pig_instructions.go`），模型在两个内核上看到同样的提示词。技能加载器按 SDK 语义自建：跟随符号链接目录、按规范化路径去重、同名先到先得、跳过没有描述的技能、排除 `disable-model-invocation` 的技能。E2E `tests/e2e/agent-skills.test.ts` 覆盖主 Agent 与图 worker 两条路径上的技能块。

15. **恢复交接的竞态已修**："已受理未发"那一路把当时那份请求与输入交给真正的重发，交接判据必须是"捕获到的值"而不是"准备动作结束了"：两者同时就绪时 `select` 会随机挑一个，挑中"结束了"就会静默放弃这次恢复，让操作永远停在 `unknown`、且不留任何痕迹。修法是值优先（`backend/internal/graph/runtime_pig_recovery.go` 的 `pigRecoveryTake`），并在确实放弃时把原因写进 daemon 的错误流。这个缺陷在高负载下约四分之一的轮次复现，由 `tests/e2e/pig-durable-recovery.test.ts` 与 `tests/e2e/go-durable.test.ts` 抓住；修后连跑 14 轮同负载全绿。

16. **TypeScript 侧车与内置 `pi-mcp-adapter` 扩展已删除**（expand–contract 的 contract 段）。Go↔TS 的侧车协议层整体退役：协议客户端、侧车配置、侧车节点宿主、侧车恢复与节点恢复共 6 个 Go 文件，加上承载 MCP 网关的 `runtime_mcp_adapter_bridge.go`（合计 7 个），以及 TS 侧的子进程入口 `src/runtime/durable-service.ts`；`--kernel node` 从此**按名字报错**（"the TypeScript durable sidecar is retired: the PiG kernel is the only kernel"）而不是继续起一个。两个内核争用同一批 durable 表必须被拒绝，不能悄悄发生。
    - 随之迁居的活路径类型没有跟着删：节点恢复的交接机制（`runtime_node_recovery.go`）、冻结记录的读取助手（`runtime_frozen_record.go`）、worker 配置与工具形状（`runtime_pi_worker_config.go`）、内核回执的结算（`core_operation_lifecycle.go`）都换到了不再提"durable sidecar"的名字下——PiG 路径一直在用它们。
    - `pi-mcp-adapter` 不再是依赖（`package.json` 与 `pnpm-lock.yaml` 一起清掉，连带 26 个包），运行时注册事件 `pi-mcp-adapter:runtime-register:v1` 与它带的网关工具 `mcp` 一起消失，能力包不再把 MCP 服务器交给扩展，插件 worker 不再注册服务器。**MCP 只剩一条路：内核自己连服务器**，模型拿到的是服务器自己的 `mcp__<server>__<tool>` 名字。
    - **MCP 声明侧保留**：Graph 仍解析 MCP 能力声明（命令、参数、环境、url、header 与密钥解析），Go 侧 `runtime_mcp_adapter_server.go` 与 TS 侧 `mcp-adapter-server.ts` 都在；变的只是承载它的通道。TypeScript 守护进程因此没有 MCP 网关了——那条退路上的会话看不到 MCP 工具，这是删除扩展的直接后果。
    - **TypeScript 守护进程本身保留**：`src/server`、`src/core/task-runtime.ts` 与 15 个 durable 运行时文件仍在，m8 套件仍覆盖它们。退役它属于另一件事，本次不夹带。
    - E2E `tests/e2e/pig-default-kernel.test.ts` 与 `tests/e2e/pig-mcp-session.test.ts` 各增一例：前者证明 `--kernel node` 被拒（daemon 起不来，消息里有 sidecar/retired），后者证明产品不再自带 MCP 扩展（依赖不在 `package.json` 里，产品源码里没有那个注册事件）。

17. **pi 扩展已由 PiG 真正承载**。逐条比对的结论与接线：
    - **Graph 侧受控 hook 是 15 个，不是 17 个**：`resources_discover`、`session_tree`、`input`、`session_start`、`session_shutdown`、`before_agent_start`、`agent_start`、`agent_end`、`turn_start`、`turn_end`、`message_start`、`message_update`、`message_end`、`tool_call`、`tool_result`，另有仅注册的 `session_checkpoint`。此前 ADR 与本文写的"17 类"从代码复现不出，以这 15(+1) 为准（依据：`src/runtime/durable-plugin-worker.mjs` 的受控 hook 清单）。
    - **PiG 侧能力齐备且更全**：PiG 对 Pi 1.3.0 有完整扩展 API 对等矩阵（`docs/extension-api-parity.md`），这 15 个 hook 全部 `wired`/`complete`；`tool_call` 可拦截与终止、`tool_result` 可改写内容，对应 Graph 的 `beforeTool`/`afterTool`；`message_start`/`message_update` 标 `partial`（PiG 自己的 D82：跨进程的部分消息观察差异）。Node 扩展走"Pi 兼容 default export"，结构上能承载 Graph 现有的 TS 扩展。
    - **承载通道接上了**：`backend/internal/pigkernel/extensions.go` 用 PiG 自己的子进程扩展宿主（`coding/extension/host/subprocess`，自带内嵌 Node 运行时，不需要外部 node）承载扩展；`backend/internal/graph/runtime_pig_extensions.go` 把扩展的工具体注册进 durable harness，并在调用前后投递扩展的 `tool_call`/`tool_result` hook。宿主是进程级常驻的，扩展只加载一次，所有会话共用。
    - **内核侧不再拒绝**：`backend/internal/pigkernel/session.go` 里那份"内核不承载 pi 扩展"的拒绝与 `ExtensionPaths` 已删除——durable 会话不承载扩展，扩展由 daemon 侧的宿主承载，不留两套并存的机制。
    - **准入留在 Graph**：扩展的工具与 Graph 自有工具走同一道闸门（`piWorkerGatedTool`）；能力清单 `capability.json` 声明了哪些工具、会话允许调用哪些工具，两道都过了才出现在模型的工具表里。扩展只拥有工具体，不拥有调用权。
    - **OS 沙箱的缺口**：Graph 的 TS 侧原本用 `@anthropic-ai/sandbox-runtime`（macOS `sandbox-exec`）限制扩展进程的文件读写与网络域，PiG 的 node 扩展进程**没有**这层，它拿到的是 daemon 自己的可达范围。因此只有与 daemon 自身可达范围同宽的会话（`Filesystem.Read/Write == "host"` 且 `Network == "unrestricted"`，默认策略即如此）才允许承载扩展；否则**按名拒绝**（`setupError` 回合失败、模型一次不被问，消息点名要解绑的能力 `proof@1.0.0`）。
    - E2E：`tests/e2e/pig-pi-extension.test.ts` 三例（①扩展工具真跑——模型被 offer 扩展注册的工具，调用真的抵达扩展进程（扩展自己写的标记文件存在），扩展自己的回答就是模型读到的；②扩展的 `tool_call` hook 拒掉调用，模型读到拒绝理由而工具体一次没跑；③窄策略按名拒绝，模型一次没被问）与 `tests/e2e/pig-node-pi-extension.test.ts`（图节点那条路径：节点在自己的内核回合里真的调用了扩展的工具，读到了扩展的回答，然后 `submit`）。
    - **顺带修好的桥接缺陷**：daemon 自己的助手消息 JSON 会**省略**空参数工具调用的 `arguments`，内核读到 `null`，任何对象模式的工具都被参数校验拒掉（"root: must be object"）。桥接（`backend/internal/pigkernel/provider.go`）现在把缺省的参数补回空对象：一次没问过参数的调用是**空参数**的调用，不是**没有参数**的调用。这条缺陷对 Graph 自有工具同样成立。

## 尚未完成的部分

1. **TypeScript 守护进程本身的退役**（与侧车不同的一件事）：`src/server`、`src/core/task-runtime.ts`（2654 行，m8 套件依赖）与 15 个 durable 运行时文件仍在。侧车协议层与内置 MCP 扩展已删，但守护进程仍是可运行的第二套会话实现，退役它要连 m8 套件一起搬。
2. **给 node 扩展进程补一层 OS 沙箱**：PiG 的 node 扩展进程有 daemon 的完整可达范围且没有 OS 沙箱，因此现在只有与 daemon 自身可达范围同宽的会话才允许承载扩展（见上第 17 条）。TS 侧那层 `sandbox-exec` 的等价实现是独立后续工作；在此之前，窄策略的会话按名拒绝而不是被静默放宽。
3. **版本落差**：PiG 钉住 Pi 1.3.0，Graph 钉住 Pi 1.1.0。durable schema 已由 E2E 证明可以从 1 升到 2 并保留原记录，但运行语义差异仍未逐条核对。PiG 的原生恢复会**重发**未答复的 provider 请求，Graph 侧因此用自己的"是否已抵达模型"判断挡住重放；两种口径的其余差异仍需逐条核对。

## 切换顺序建议

先让 Go 宿主接管同一份 `graph_durable_` 命名空间（已在数据层证明可行），再逐段替换会话行为；每段由现有真实 E2E（`tests/e2e/go-durable.test.ts` 等）把关。宿主协议若保持 Unix socket 行协议不变，切换可回退；正式切换后不保留旧内核回退执行入口（沿用 [ADR 0031](../adr/0031-pi-durable-agent-kernel.md) 的既有约定）。

当前进度：数据层 → 会话层 → 模型与工具通道 → 原生工具 → 崩溃恢复（主 Agent）→ 图节点泳道的活路径与崩溃恢复 → **默认内核翻转** → **侧车与内置 MCP 扩展退役** → **pi 扩展真承载** → **codemode 默认开启**均已落地并有 E2E；剩下的关口是 TypeScript 守护进程本身的退役、给 node 扩展进程补 OS 沙箱，以及 Pi 1.1.0→1.3.0 的运行语义逐条核对。

## 内核选择

迁移期间 daemon 可以显式选择内核，默认已是 Go 进程内的 PiG 内核：

```bash
graphd --kernel pig    # 默认：Go 进程内的 PiG 内核：主 Agent 会话、崩溃恢复与图节点泳道
graphd --kernel node   # 已退役：TypeScript durable 侧车——按名字报错，不再是退路
```

内核一经选择即在本进程内固定。TypeScript 侧车连同承载它的协议层已经退役，`--kernel node` 现在直接报错退出（消息里写明 sidecar 已 retired）：PiG 内核是唯一的内核，两个内核争用同一批 durable 表是必须拒绝的，而不是悄悄起一个。

## 内核诊断入口

迁移期间有两个只读/单回合的公开入口，都直接操作真实 Graph 数据库，不启动控制台也不派发 Graph 任务：

```bash
# 报告 PiG 内核在正式数据库的 durable 命名空间里看到了什么（会话、条目、提交、schema 版本）
graphd --pig-kernel-inspect <database>

# 用 daemon 自己的模型与凭据，在 PiG 内核上跑一个真实回合（可带 Graph 工具）
graphd --pig-kernel-turn <database> --config <config> --kernel-model <modelId> --kernel-prompt <text>
```

## 内核更新

```bash
pnpm pig:kernel   # 报告当前钉住版本与上游最新版本
pnpm pig:check    # 漂移门禁：落后于上游时失败
pnpm pig:update   # 一键更新到上游最新版本并重建
```

更新只改钉住版本与依赖图，不静默改变运行中桌面应用的内核版本；切换仍需走既有验收。
