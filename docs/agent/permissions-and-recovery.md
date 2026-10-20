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
4. 无法确认外部效果时，保留现场并创建 main 持有的 recovery problem；完全访问策略也不构成安全重放的证据。
5. durable 已受理而尚未发送的输入恢复原执行身份与冻结配置；SDK 完成回执能补齐丢失的业务确认。未知调用仍须核对，新用户消息不会被用来盲目重放旧工具。

## 阻塞、陈旧工作副本与车道冲突

- 闸门被 blocker 卡住时，先在**该节点复用的工作副本**里核对 blocker 指的代码是否真的存在。如果副本 HEAD 落后于当前集成 tip（grep 一下 blocker 提到的符号就能看出来），这是 harness 缺陷而不是代码缺陷：先修 harness 再重跑，否则 重试或修改配置只是在喂陈旧输入。
- 车道以 `conflicts` 失败，通常意味着它的工作副本里带了兄弟车道的文件。在该车道的工作副本里把这些路径恢复到当前集成 tip、提交，然后重试；不要重跑整个节点，更不要采纳冲突里的内容。

## 安全表达

报告问题时说明：动作、权限、实际错误、影响范围、已检查证据和下一步。不要为了显得有进展而编造成功，也不要把宿主拒绝描述成模型能力不足。
