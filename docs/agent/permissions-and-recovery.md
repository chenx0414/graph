# Permissions and Recovery

## 权限不是 prompt

System prompt 可以解释权限，但不能授予权限。真正边界由宿主在每次 operation 派发前解析并冻结，包括：

- 文件读取和写入 root；
- 可执行命令；
- 网络域和本地绑定；
- Unix socket、Apple Events 和 extension runtime；
- Git metadata 保护；
- capability grants；
- access policy mode。

Agent 或用户编辑 prompt 不能改变这些控制面。

## 标准与完全访问

默认完全访问模式自动批准运行授权，允许宿主文件系统、任意命令、无限制网络、Pi extension 宿主运行时、本地绑定、Unix socket、Apple Events、Git metadata 和 credential stores。暂停、预算、未知用量、恢复问题和讨论期只读策略不阻塞调用；操作、invocation、用量和事件仍会记录，供界面与审计使用。

标准模式仍可显式选择，恢复 workspace、命令白名单、声明网络、受保护路径和逐项授权。并发上限、人工验收、模型订阅决策和任务图确认不属于调用权限，仍按原规则执行。

运行中的 operation 保留派发时冻结的策略；策略变更只影响下一次准入。

## 预算和 usage

每次模型调用记录 usage：

- `authoritative`：供应商逐请求返回；
- `account_delta`：可归属到本次调用的账户差额；
- `estimated`：本地估算；
- `unknown`：没有可核算事实。

有限预算只在 authoritative/account_delta 下继续。缺失 usage 不能记成零。未知 usage 按问题规则处理，重试和恢复不会重置额度。

## 暂停

标准模式下暂停先关闭调用门，不允许新模型或工具请求；已发送调用可以结束。完全访问模式下暂停记录仍可查看，但不会阻止新的模型或工具调用。

## 问题所有权

问题由 `owner` 分为 Main Agent 与用户：

直接给用户：

- 权限；
- 预算；
- 人工验收；
- 必须由用户作出的明确产品决策。

先给 Main Agent：

- 恢复不明；
- adapter/context/provider 错误；
- Git 冲突；
- unknown usage；
- result handoff 或 evidence 不合规；
- 停滞、返工和内部一致性问题。

Main Agent 处理后再决定是否升级为用户问题。用户不应看到未整理的 stack trace、原始 JSON 或内部状态。

## 未知外部结果

如果某个外部动作可能已经发生，但无法确认结果：

1. 查询已有 operation、artifact、Git 和外部结果；
2. 若可证明未发生且动作可重做，按 retry；
3. 若可证明已发生，补记并继续；
4. 标准模式下若仍不确定，保持阻塞并创建 recovery problem；
5. 完全访问模式下释放为可重试，并记录 `operation.recovery_bypassed`，不保留 recovery 阻塞问题。

## 安全表达

报告问题时说明：动作、权限、实际错误、影响范围、已检查证据和下一步。不要为了显得有进展而编造成功，也不要把宿主拒绝描述成模型能力不足。
