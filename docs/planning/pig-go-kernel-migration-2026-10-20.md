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
11. **codemode 已接入，默认关闭**：`backend/internal/graph/runtime_pig_codemode.go` 把内核自带的 QuickJS 沙箱接到 daemon 的主机侧。模型写一段 JavaScript，脚本能调用的就是该会话自己的工具，每一次调用仍走同一道准入闸门（沙箱改变的是调用怎么写，不是调用准不准）；`submit` 这类宿主自己的工具不进沙箱，脚本也不能再起一个脚本。Graph 只在配置显式要求时提供这个工具：`graph.config.json` 的 `codemode.enabled`。E2E `tests/e2e/pig-codemode.test.ts` 用真实 daemon、真实 provider 与真实宿主工具证明：模型收到 `codemode` 声明 → 调用它 → 脚本在沙箱里调用宿主的 `write` 工具 → 文件落在工作副本 → 答复带回脚本看到的内容；另一个用例证明没配置时模型看不到这个工具。

## 尚未完成的部分

1. **节点泳道的崩溃恢复尚未移植**：节点的**活路径**已在 PiG 内核上，但 daemon 崩溃时正在跑的节点回合还没有等价的三分法处理。现状是：崩溃恢复把该节点执行置为 `blocked`、队列项放回 `queued`、任务置为 `blocked`（与 TS 路径的启动恢复同一步），但 TS 路径此后由侧车的恢复 pass 自动重发那一回合，PiG 路径没有这一步。已具备的零件是：节点回合的冻结执行（与主 Agent 同文档同形状）、内核的提交回执、`pigNodeRecoveredAttempt`（内核仍持受理且从未抵达模型时保住那次 attempt）。缺的是把"已受理未发出 → 用受理时的配置重发"这一步接到节点的启动恢复上，以及处理内核调度器在别的会话提交时顺带恢复该节点任务、可能重发已抵达模型的 provider 请求这一冲突。**这一项是默认内核翻转前的最后关口。**
2. **MCP 原生化收尾**：删除 `pi-mcp-adapter` 扩展与运行时注册事件 `pi-mcp-adapter:runtime-register:v1`，前提是 PiG 内核成为默认内核；节点绑定到 MCP 能力的语义已由产品级 E2E 证明等价。
3. **pi 扩展模型**：PiG 的扩展是 Go/Rust/Python/Node 资源，与现有"沙箱内加载 TS pi 扩展"形态不等价；17 类 hook 与 `beforeTool`/`afterTool` 的对应能力尚未逐条核对，这是本次迁移最大的未验证项。
4. **版本落差**：PiG 钉住 Pi 1.3.0，Graph 钉住 Pi 1.1.0。durable schema 已由 E2E 证明可以从 1 升到 2 并保留原记录，但运行语义差异仍未逐条核对。PiG 的原生恢复会**重发**未答复的 provider 请求，Graph 侧因此用自己的"是否已抵达模型"判断挡住重放；两种口径的其余差异仍需逐条核对。

## 切换顺序建议

先让 Go 宿主接管同一份 `graph_durable_` 命名空间（已在数据层证明可行），再逐段替换会话行为；每段由现有真实 E2E（`tests/e2e/go-durable.test.ts` 等）把关。宿主协议若保持 Unix socket 行协议不变，切换可回退；正式切换后不保留旧内核回退执行入口（沿用 [ADR 0031](../adr/0031-pi-durable-agent-kernel.md) 的既有约定）。

当前进度：数据层 → 会话层 → 模型与工具通道 → 原生工具 → 崩溃恢复（主 Agent）→ 图节点泳道的活路径均已落地并有 E2E；剩下的关口是节点泳道的崩溃恢复，它决定默认内核能否翻转。

## 内核选择

迁移期间 daemon 可以显式选择内核，默认仍是 TypeScript 侧车：

```bash
graphd --kernel node   # 默认：TypeScript durable 侧车
graphd --kernel pig    # Go 进程内的 PiG 内核：主 Agent 会话、崩溃恢复与图节点泳道
```

内核一经选择即在本进程内固定：选 PiG 时 daemon 不会启动 TypeScript 侧车，需要侧车的路径会明确报错而不是静默争用同一份 durable 命名空间。

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
