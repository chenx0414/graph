# ADR 0032：Go 后端与共享 durable SDK 宿主

2026-10-20，后端迁移至 Go；使用者同时要求合入并保留 ADR 0031 的 pi-durable 1.1.0 执行模型。Go 拥有 HTTP/SSE、Graph 业务状态、凭据、准入与用量；每个正式 SQLite 数据库由一个 Node 辅助进程承载共享 durable Harness，main 与节点使用同一套稳定会话和输入收据。私有 Unix socket 仅传递会话命令与宿主回调，模型凭据留在 Go，原生工具执行前仍向 Go 申请准入。

选择保留上游 SDK 的持久执行语义，避免重写 SDK 或恢复两套 Agent 循环。durable 表继续使用正式数据库中的独立命名空间。SQLite 写入采用有界锁等待；完成收据可以恢复丢失的 Graph 确认，未知工具效果和未知用量仍须核对，完全访问权限不能作为安全重放的证据。ADR 0006 中 TypeScript 作为领域内核实现语言的选择由本决策取代；ADR 0030 的接口投递模型与 ADR 0031 的共享 durable 执行规则继续适用。
