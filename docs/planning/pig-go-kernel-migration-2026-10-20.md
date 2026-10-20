# PiG 内核迁移计划与状态（2026-10-20）

目标：把 Graph 的 Agent 执行内核从 TypeScript 的 `@earendil-works/pi-*` 1.1.0 换成 Go 版 Pi（PiG），MCP 全部走内核原生通道，并让上游内核可以一键更新。分支 `feature/pig-go-kernel`，基线 main `e8f6784`。

决策与依据：[ADR 0033](../adr/0033-pig-go-kernel.md)、[三项能力核对](../research/pig-go-kernel-2026-10-20.md)。

## 已完成并有证据的部分

1. **三项能力核对**：PiG 有 durable（`durable/`，950 个 Go 文件，逐文件移植 `@earendil-works/pi-durable`）、有原生 MCP（`mcp/`，stdio 与可流式 HTTP，含 OAuth；`pig mcp add|list` 与 `mcp.json`）、有 codemode（`codemode/`，QuickJS/wazero，内置 `codemode` 与 `tool_search`）。三项均为肯定。
2. **内核依赖与更新机制**：`backend/go.mod` 钉住 `github.com/MichaelKinsy/PiG v0.5.1`；`pnpm pig:update` 解析上游最新版本、改写钉住、整理依赖、重建后端并校验，失败时回滚到原状态。E2E：`tests/e2e/pig-kernel-update.test.ts`（真实网络、真实 Go 编译、真实回滚）。
3. **数据接续已证明**：`backend/internal/pigkernel` 用 PiG 的 SQLite 端口直接接管正式数据库的 `graph_durable_` 命名空间（PiG 原生支持表前缀，不再需要 TS 侧那层 SQL 词法改写）。E2E：`tests/e2e/pig-kernel.test.ts` 证明 PiG 内核能按相同标识读出 daemon 写入的 durable 会话与条目，PiG 的迁移把 durable schema 从版本 1 升到 2，且不改动原记录。
4. **内核能跑真实回合已证明**：`backend/internal/pigkernel/turn.go` 用 PiG 的 `durable/harness` 装配会话：daemon 决定模型、凭据、工具与准入，内核执行 provider 调用与工具往返，并把身份映射、提交与条目写回同一命名空间。E2E 同文件第二例用真实 HTTP 模型服务跑完"模型调用 `read` 工具 → daemon 读文件 → 结果回到模型 → 最终答复"，并断言 transcript 与提交都在 Graph 数据库里。

## 尚未完成的部分

1. **会话层移植**：现有 `src/runtime/durable-*.ts`（约 1400 行）负责 Harness 装配、冻结与恢复、compaction、事件桥接；内核回合执行器已能跑通一个回合，但常驻会话、冻结执行与恢复、compaction 与事件桥接仍需移植，并由 `graph.AgentSessionTransport` 直接承接，删除 Node 侧车 `src/runtime/durable-service.ts`。
2. **模型与工具通道**：模型调用已经由 PiG 的 `ai` 包执行，凭据仍由 daemon 解析后交给内核；发送闸门（broker）与用量结算尚未包进 `durable.Models`，daemon 侧的原生工具实现（read/bash/edit/write 等）也尚未在 Go 中落地。
3. **恢复语义**：冻结执行、受理未发送输入、SDK 完成但 Graph 未确认的结算，必须先有 Go 侧等价物，再切换宿主；切换前的 TS 内核不能退出。
4. **MCP 原生化**：删除 `pi-mcp-adapter` 扩展与运行时注册事件 `pi-mcp-adapter:runtime-register:v1`，MCP 服务器由 PiG 内核直接注册；节点绑定到 MCP 能力的语义需先证明等价。
5. **codemode 启用**：内核内置 `codemode` 与 `tool_search` 默认关闭，由 Graph 按需显式启用，不改变既有准入与沙箱策略。
6. **pi 扩展模型**：PiG 的扩展是 Go/Rust/Python/Node 资源，与现有"沙箱内加载 TS pi 扩展"形态不等价；17 类 hook 与 `beforeTool`/`afterTool` 的对应能力尚未逐条核对，这是本次迁移最大的未验证项。

## 切换顺序建议

先让 Go 宿主接管同一份 `graph_durable_` 命名空间（已在数据层证明可行），再逐段替换会话行为；每段由现有真实 E2E（`tests/e2e/go-durable.test.ts` 等）把关。宿主协议若保持 Unix socket 行协议不变，切换可回退；正式切换后不保留旧内核回退执行入口（沿用 [ADR 0031](../adr/0031-pi-durable-agent-kernel.md) 的既有约定）。

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
