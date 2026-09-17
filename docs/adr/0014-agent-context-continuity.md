# Agent 上下文采用 continue、fresh 与 fork 三种模式

Agent 实例第一次执行时，由 Graph 的程序解析上下文来源，而不是由模型直接选择：

- `fresh`：创建空 session，只注入冻结的 handoff、任务、验收、决策与产物引用。
- `fork`：从同一图中某个已成功 Agent 节点的冻结 leaf 复制 root-to-leaf 上下文，创建新 session file 与新 session ID，再追加当前任务 delta。
- `continue`：已有实例再次执行时沿用原 session，用于返工、恢复和主 Agent 连续对话。

模型只能提交 `purpose`、`requiredFacts`、`sourceNode` 与独立性要求。只有请求 `transcript_range` 或 `tool_call` 时程序才选择 `fork`；默认与所有独立审查都选择 `fresh`。独立审查不能继承实现 transcript。

## 结果

- 一个 Agent 实例仍只对应一个 Agent 节点。Fork 创建新的实例与节点，不共享可变 session。
- session JSONL 只承载 transcript 与模型/思考历史；能力包、工具策略和权限仍由 Graph manifest、调用门与任务授权管理。
- Fork 默认要求源与目标使用相同模型、Agent 定义和能力包。不同配置必须显式 `rebrand`，并失去“完整继承”与缓存前缀保证。
- Fork 与源实例共享 `BudgetScope`，不能用新建实例重置累计额度；写入型 Agent 仍使用独立工作副本。
- Graph 持久化 context binding、resolution、handoff digest、source session/leaf digest、child digest 与预算作用域，供恢复和 UI 审计。

## 未采用

- 不允许多个 Pi 进程并发写入同一 session file；Pi 未提供该并发写保证。
- 不把“新建 session”自动等同于独立验证。独立还需要 evidence-only handoff、模型排除和独立报告 schema。
- 不让模型直接输出执行模式，也不允许在 fork 后重复注入完整历史摘要。
