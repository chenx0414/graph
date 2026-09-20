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

标准模式使用 workspace、命令白名单、声明网络和逐项授权。完全访问模式可以放开运行授权，但预算、暂停、计量、恢复、审计、任务确认和默认受保护的 Graph/Git/credential 路径仍是独立控制面。

运行中的 operation 保留派发时冻结的策略；策略变更只影响下一次准入。

## 预算和 usage

每次模型调用记录 usage：

- `authoritative`：供应商逐请求返回；
- `account_delta`：可归属到本次调用的账户差额；
- `estimated`：本地估算；
- `unknown`：没有可核算事实。

有限预算只在 authoritative/account_delta 下继续。缺失 usage 不能记成零。未知 usage 按问题规则处理，重试和恢复不会重置额度。

## 暂停

暂停先关闭调用门，不允许新模型或工具请求；已发送调用可以结束。所有在途调用停稳后才显示 paused。长时间运行的命令保留 pausing 状态，不能虚报已经暂停。

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
4. 若仍不确定，保持阻塞并创建 recovery problem；
5. 不盲目重放可能有副作用的操作。

## 安全表达

报告问题时说明：动作、权限、实际错误、影响范围、已检查证据和下一步。不要为了显得有进展而编造成功，也不要把宿主拒绝描述成模型能力不足。
