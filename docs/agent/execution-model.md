# Graph Execution Model

## 图与版本

任务图由 proposal 创建，用户确认后成为正式图版本。图可以包含：

- Agent node；
- Program node；
- 子图/container；
- 顺序和依赖边；
- 条件路由；
- fan-out / fan-in；
- 主管-工人等待与唤醒；
- 回到原节点和原 instance 的返工回环。

图修订使用新版本，不原地覆盖历史。已确认的 acceptance 和关键程序检查输入不能在修订通道中静默改变。

## Agent Instance

一个 Agent node 对应一个 Agent instance。Instance 拥有：

- 稳定 instance id；
- Agent definition version；
- session；
- Git worktree；
- 预算作用域和累计 usage；
- activation history；
- 可恢复的 context binding。

返工、恢复和模型切换保持 instance 身份；新 Fork 或 Fresh 执行创建新的 node/instance 关系。

## Operation

所有真实外部动作都先写 operation intent，再派发，再结算。实际动作包括：

- 模型请求；
- 工具调用；
- 命令执行；
- MCP 调用；
- extension 请求；
- provider retry、compact 和 summary；
- Git 写入；
- 共享 artifact 发布。

Operation 通过调用门执行。暂停、预算、权限、并发和恢复规则在真实派发前检查，而不是只在 agent turn 开始时检查。

## 激活与循环

Activation 区分同一节点的新一轮执行。回环返回到原节点时：

- 不创建新的 Agent 身份；
- 保留 session、worktree 和累计预算；
- 使用新的 activation id；
- 旧轮次 evidence 不能验证新输入。

汇合节点绑定本轮分支集合、activation 和输入版本。旧轮次成功不能错误满足新轮次。

## 并发

整个任务图共享 Agent 并发名额，Main Agent 也计入。等待依赖或用户时会释放名额；恢复执行前重新获取。Program node 不占 Agent 名额，但工具进程仍可受宿主资源控制。对话阶段的主管在会话未归档时，由待处理消息、显式恢复、问题答复或执行续轮触发调度。消息已消费且队列为空的异常回合不会自动重试；空队列不阻止显式恢复或答复后的继续执行。

## 返工与独立性

- 实现节点和其直接后继默认使用 `result_handoff`。
- Fresh 审查与验证只读取 acceptance、evidence、artifact 和冻结事实，使用 `evidence_only`。
- 独立审查默认排除本轮实现使用过的模型集合。
- Fork 只用于必须继承精确 transcript/tool-call 事实的情况，不用于普通探索。

## 恢复

后台重启或 worker 消失后，Graph 先核查：

- operation 是否已派发；
- 外部动作是否留下可识别结果；
- worker/session 是否仍存在；
- Git、artifact 或命令是否已经产生副作用。

结果明确时补记；确认没有发生且可以重做时才 retry；结果不明时阻塞并生成由 Main Agent 处理的 recovery problem。不能承诺任意外部操作 exactly-once。

## 进度判断

有证据关闭问题、通过此前失败的检查、产生合法 artifact/result handoff 才算进展。重复改写说明、重复启动同一失败动作或跳过检查不算进展。连续多轮无进展应升级给用户。
