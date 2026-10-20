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

## 实施状态（2026-10-20）

内核选择由 `graphd --kernel node|pig` 显式决定，默认仍是 `node`：TypeScript 侧车仍承载恢复语义与图节点泳道，这两项尚未有 Go 侧等价物。

已落地并有 E2E 的部分：

- **主 Agent 常驻会话跑在 PiG 内核**（`backend/internal/pigkernel/session.go`、`backend/internal/graph/runtime_pig_session.go`）。内核进程内常驻，按身份寻址 durable 会话，装配方与工具，连原生 MCP，订阅内核事件。
- **模型通道仍归 daemon**（`backend/internal/pigkernel/provider.go`）。PiG 的 provider 运行时接受任意 stream 实现，因此 daemon 把自己那条受控流交给内核：内核向 daemon 要答案，daemon 决定是否放行、花哪把凭据、记哪笔用量。内核因此拿不到一条绕过准入或预算的 provider 通道。
- **原生工具由 daemon 提供**（`backend/internal/graph/runtime_pig_native_tools.go`）。TypeScript SDK 原本提供 read/write/edit/ls/find/grep 与 shell；PiG 内核不自带环境，这套工具在 Go 侧补齐，名字与声明与 SDK 一致，路径规则复用 Graph 既有的越界保护。
- **两个内核不得同时写一份 durable 命名空间**：选 `pig` 时 daemon 不启动 TypeScript 侧车，需要侧车的路径（崩溃恢复引导、图节点泳道）显式报错，而不是静默争用同一批表。

未落地、因此默认内核尚未翻转的部分：恢复语义（冻结执行、受理未发送输入、SDK 完成但 Graph 未确认的结算）、图节点泳道、codemode 启用、PiG 扩展模型与既有 TS pi 扩展的等价性核对。

MCP 的产品级通道已证明可用：Graph 的能力目录里绑定一个真实 MCP 服务器，模型直接收到 `mcp__<server>__<tool>` 声明并直呼该工具，没有网关工具、没有扩展事件总线（E2E `tests/e2e/pig-mcp-session.test.ts`）。

## 与既有决策的冲突

本决策取代 ADR 0032 的"Node 辅助进程承载共享 durable Harness"实现选择；ADR 0032 中"Go 拥有 HTTP/SSE、业务状态、凭据、准入与用量"的分工被保留并加强为"模型通道由 daemon 提供"。ADR 0006 关于 TypeScript 作为领域内核实现语言的选择，其内核部分由本决策取代；Web 与桌面壳仍为 TypeScript。
